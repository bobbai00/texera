/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.web.service.execution

import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_OF_USER,
  WORKFLOW_USER_ACCESS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserWarehouseFlavorEnum,
  WorkflowComputingUnitTerminationReasonEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowVersion
}
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder, WorkflowExecutionStatus}
import org.jooq.impl.{DSL, SQLDataType}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.jdk.CollectionConverters._

/**
  * Specs for [[ExecutionRecords]]: the rows of `workflow_executions` as the Dashboard service
  * closes them, in `MockTexeraDB`. Nothing here reads the lake.
  */
class ExecutionRecordsSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val creatorUid = 9831
  private val ownerUid = 9832
  private val grantedUid = 9833
  private val strangerUid = 9834

  private val testWid = 9841
  private val publicWid = 9842

  private val liveCuid = 9851
  private val userTerminatedCuid = 9852
  private val sweptCuid = 9853

  private val warehouseName = s"user-$creatorUid-7"
  private var whid: Integer = _
  private var recorder: StatementRecorder = _

  private val terminatedAtMs = 1794873000000L
  private val createdAtMs = 1794873600000L

  // Explicit ids, so a case can name a row before it is there.
  private val nextEid = new AtomicInteger(983000)

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()

    Seq(creatorUid, ownerUid, grantedUid, strangerUid).foreach { uid =>
      val user = new User
      user.setUid(uid)
      user.setName(s"execution-records-user-$uid")
      user.setEmail(s"execution-records-${UUID.randomUUID()}@example.com")
      new UserDao(cfg).insert(user)
    }
    Seq(testWid -> false, publicWid -> true).foreach {
      case (wid, public) =>
        val workflow = new Workflow
        workflow.setWid(wid)
        workflow.setName(s"execution-records-workflow-$wid")
        workflow.setContent("{}")
        workflow.setDescription("")
        workflow.setIsPublic(public)
        workflow.setCreationTime(new Timestamp(createdAtMs))
        workflow.setLastModifiedTime(new Timestamp(createdAtMs))
        new WorkflowDao(cfg).insert(workflow)
        val version = new WorkflowVersion
        version.setWid(wid)
        version.setContent("{}")
        version.setCreationTime(new Timestamp(createdAtMs))
        new WorkflowVersionDao(cfg).insert(version)
        getDSLContext
          .insertInto(WORKFLOW_OF_USER)
          .set(WORKFLOW_OF_USER.UID, Integer.valueOf(ownerUid))
          .set(WORKFLOW_OF_USER.WID, Integer.valueOf(wid))
          .execute()
    }
    getDSLContext
      .insertInto(WORKFLOW_USER_ACCESS)
      .set(WORKFLOW_USER_ACCESS.UID, Integer.valueOf(grantedUid))
      .set(WORKFLOW_USER_ACCESS.WID, Integer.valueOf(testWid))
      .set(WORKFLOW_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()

    Seq(
      liveCuid -> None,
      userTerminatedCuid -> Some(WorkflowComputingUnitTerminationReasonEnum.USER_REQUESTED),
      sweptCuid -> Some(WorkflowComputingUnitTerminationReasonEnum.GARBAGE_COLLECTED)
    ).foreach {
      case (cuid, terminated) =>
        val unit = new WorkflowComputingUnit
        unit.setCuid(cuid)
        unit.setUid(creatorUid)
        unit.setName(s"execution-records-unit-$cuid")
        unit.setCreationTime(new Timestamp(createdAtMs))
        terminated.foreach { reason =>
          unit.setTerminateTime(new Timestamp(terminatedAtMs))
          unit.setTerminationReason(reason)
        }
        unit.setType(WorkflowComputingUnitTypeEnum.local)
        unit.setUri("local://test")
        unit.setResource("{}")
        new WorkflowComputingUnitDao(cfg).insert(unit)
    }

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(creatorUid)
    warehouse.setName(warehouseName)
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid
  }

  override protected def afterAll(): Unit =
    try closeConnectionPool()
    finally super.afterAll()

  // --- fixtures ---

  /** Inserts an open execution, as a create leaves one, and answers its id. */
  private def insertExecution(
      wid: Int = testWid,
      cuid: Option[Int] = Some(liveCuid),
      uid: Int = creatorUid,
      warehouse: Option[Integer] = None,
      startedAtMs: Long = createdAtMs,
      notification: Option[String] = None
  ): Long = {
    val eid = nextEid.getAndIncrement()
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(uid))
      .set(WORKFLOW_EXECUTIONS.CUID, cuid.map(Integer.valueOf).orNull)
      .set(WORKFLOW_EXECUTIONS.STATUS, Short.box(WorkflowExecutionStatus.Created))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, new Timestamp(startedAtMs))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.WHID, warehouse.orNull)
      .set(WORKFLOW_EXECUTIONS.NOTIFICATION, notification.orNull)
      .execute()
    eid.toLong
  }

  private def row(eid: Long): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration())
      .fetchOneByEid(Integer.valueOf(eid.toInt))

  private def record(eid: Long): ExecutionRecord =
    ExecutionRecords.find(eid).getOrElse(fail(s"execution $eid has no row"))

  private val completed = WorkflowExecutionStatus.Completed
  private val failed = WorkflowExecutionStatus.Failed
  private val killed = WorkflowExecutionStatus.Killed

  private def closedByVerdict(endedAtMs: Long, reason: String = "unit lost"): Long = {
    val eid = insertExecution()
    ExecutionRecords.close(eid, failed, Some(reason), endedAtMs, fromLog = false) shouldBe true
    eid
  }

  // --- reading ---

  "ExecutionRecords.find" should "read a row with its workflow, its creator, its unit and when it was created" in {
    val eid = insertExecution(notification = Some("""{"email":"creator@example.com"}"""))

    record(eid) shouldBe ExecutionRecord(
      eid = eid,
      wid = testWid,
      uid = creatorUid,
      cuid = Some(liveCuid),
      warehouse = None,
      startingTimeMs = createdAtMs,
      notification = Some("""{"email":"creator@example.com"}"""),
      unitTerminatedAtMs = None,
      unitTerminationReason = None,
      closing = None,
      resultsExpiredAtMs = None
    )
  }

  it should "say when the execution's results were dropped, to the millisecond, and not before" in {
    val eid = insertExecution()
    ExecutionRecords.close(eid, completed, None, createdAtMs + 1000L, fromLog = true)
    record(eid).resultsExpiredAtMs shouldBe None

    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(
        WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT,
        DSL.value(new Timestamp(createdAtMs + 86401234L), SQLDataType.TIMESTAMP(3))
      )
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
      .execute()
    record(eid).resultsExpiredAtMs shouldBe Some(createdAtMs + 86401234L)

    // An execution no unit started is closed with nothing to expire.
    val unstarted = insertExecution()
    ExecutionRecords.close(
      unstarted,
      failed,
      Some("never started"),
      createdAtMs + 600000L,
      fromLog = false,
      neverStarted = true
    )
    record(unstarted).resultsExpiredAtMs shouldBe Some(createdAtMs + 600000L)
  }

  it should "name the warehouse the execution writes into, and none once that warehouse is deleted" in {
    val eid = insertExecution(warehouse = Some(whid))
    record(eid).warehouse shouldBe Some(warehouseName)
    record(eid).planUri.toString shouldBe s"vfs:///wh/$warehouseName/wid/$testWid/eid/$eid/plan"
    record(eid).logUri.toString shouldBe
      s"vfs:///wh/$warehouseName/wid/$testWid/eid/$eid/executionlog"
    record(eid).statisticsUri.toString shouldBe
      s"vfs:///wh/$warehouseName/wid/$testWid/eid/$eid/runtimestatistics"
    record(eid).consoleUri.toString shouldBe
      s"vfs:///wh/$warehouseName/wid/$testWid/eid/$eid/consolemessages"

    // What deleting the warehouse leaves: the foreign key sets the row's whid to null.
    val deleted = insertExecution(warehouse = None)
    record(deleted).warehouse shouldBe None
    record(deleted).planUri.toString shouldBe s"vfs:///wid/$testWid/eid/$deleted/plan"
    record(deleted).statisticsUri.toString shouldBe
      s"vfs:///wid/$testWid/eid/$deleted/runtimestatistics"
    record(deleted).consoleUri.toString shouldBe
      s"vfs:///wid/$testWid/eid/$deleted/consolemessages"
  }

  it should "say when and why the execution's unit was terminated" in {
    val byUser = record(insertExecution(cuid = Some(userTerminatedCuid)))
    byUser.unitTerminatedAtMs shouldBe Some(terminatedAtMs)
    byUser.unitTerminationReason shouldBe
      Some(WorkflowComputingUnitTerminationReasonEnum.USER_REQUESTED)

    val swept = record(insertExecution(cuid = Some(sweptCuid)))
    swept.unitTerminatedAtMs shouldBe Some(terminatedAtMs)
    swept.unitTerminationReason shouldBe
      Some(WorkflowComputingUnitTerminationReasonEnum.GARBAGE_COLLECTED)
  }

  it should "read an execution that names no unit" in {
    val unitless = record(insertExecution(cuid = None))
    unitless.cuid shouldBe None
    unitless.unitTerminatedAtMs shouldBe None
  }

  it should "find no execution for an id that names none" in {
    Seq(0L, -1L, 999999999L, Int.MaxValue.toLong + 1, Long.MaxValue, Long.MinValue).foreach { eid =>
      withClue(s"$eid: ") { ExecutionRecords.find(eid) shouldBe None }
    }
  }

  "ExecutionRecords.open" should "list the executions with no closing record, oldest first, in one statement" in {
    val first = insertExecution()
    val closed = insertExecution()
    val second = insertExecution(cuid = Some(sweptCuid), warehouse = Some(whid))
    ExecutionRecords.close(closed, completed, None, createdAtMs + 1000L, fromLog = true)

    var open: Seq[ExecutionRecord] = Nil
    val statements = recorder.record { open = ExecutionRecords.open() }

    statements.map(_.verb) shouldBe Seq("SELECT")
    open.map(_.eid) shouldBe open.map(_.eid).sorted
    open.map(_.eid) should contain allOf (first, second)
    open.map(_.eid) should not contain closed
    open.forall(_.closing.isEmpty) shouldBe true
    open.find(_.eid == second).get shouldBe record(second)
  }

  "ExecutionRecords.openBefore" should "list the open executions of the workflow on the unit made before another, oldest first" in {
    val first = insertExecution()
    val closed = insertExecution()
    ExecutionRecords.close(closed, completed, None, createdAtMs + 1000L, fromLog = true)
    val second = insertExecution()
    val otherUnit = insertExecution(cuid = Some(sweptCuid))
    val unitless = insertExecution(cuid = None)
    val otherWorkflow = insertExecution(wid = publicWid)
    val before = insertExecution()
    val later = insertExecution()

    var found: Seq[ExecutionRecord] = Nil
    val statements =
      recorder.record { found = ExecutionRecords.openBefore(testWid, liveCuid, before) }

    statements.map(_.verb) shouldBe Seq("SELECT")
    val listed = found.map(_.eid)
    listed shouldBe listed.sorted
    listed should contain allOf (first, second)
    listed should contain noneOf (closed, otherUnit, unitless, otherWorkflow, before, later)
    found.find(_.eid == second).get shouldBe record(second)
    found.forall(execution => execution.closing.isEmpty && execution.eid < before) shouldBe true
  }

  /** The executions among `eids` whose rows meet `ExecutionRecords.statusAmong(codes)`. */
  private def among(eids: Seq[Long], codes: Short*): Seq[Long] =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.EID)
      .from(WORKFLOW_EXECUTIONS)
      .where(
        WORKFLOW_EXECUTIONS.EID
          .in(eids.map(eid => Integer.valueOf(eid.toInt)).asJava)
          .and(ExecutionRecords.statusAmong(codes.toSet))
      )
      .orderBy(WORKFLOW_EXECUTIONS.EID)
      .fetch(WORKFLOW_EXECUTIONS.EID)
      .asScala
      .map(_.longValue())
      .toSeq

  "ExecutionRecords.statusAmong" should "take a closed execution by its outcome, and every open one for a status that is no ending" in {
    val open = insertExecution()
    val Seq(done, broken, stopped) = Seq(completed, failed, killed).map { outcome =>
      val eid = insertExecution()
      ExecutionRecords.close(eid, outcome, None, createdAtMs + 1000L, fromLog = true)
      eid
    }
    val all = Seq(open, done, broken, stopped)
    // What the status column says is no part of it: the open one is "completed" there.
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.STATUS, Short.box(completed))
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(open.toInt)))
      .execute()

    among(all) shouldBe all
    among(all, completed) shouldBe Seq(done)
    among(all, failed, killed) shouldBe Seq(broken, stopped)
    Seq[Short](
      WorkflowExecutionStatus.Initializing,
      WorkflowExecutionStatus.Running,
      WorkflowExecutionStatus.Paused,
      WorkflowExecutionStatus.Created,
      WorkflowExecutionStatus.Unknown
    ).foreach { code =>
      withClue(s"status $code: ") {
        among(all, code) shouldBe Seq(open)
        among(all, code, failed) shouldBe Seq(open, broken)
      }
    }
  }

  // --- closing ---

  "ExecutionRecords.close" should "write how, why and when the execution ended, and where the outcome is from" in {
    val eid = insertExecution()

    ExecutionRecords.close(
      eid,
      failed,
      Some("java.lang.RuntimeException: boom"),
      createdAtMs + 42000L,
      fromLog = true
    ) shouldBe true

    record(eid).closing shouldBe Some(
      ClosingRecord(failed, Some("java.lang.RuntimeException: boom"), createdAtMs + 42000L, true)
    )
    val closed = row(eid)
    closed.getOutcome shouldBe failed
    closed.getOutcomeReason shouldBe "java.lang.RuntimeException: boom"
    closed.getEndedAt shouldBe new Timestamp(createdAtMs + 42000L)
    closed.getOutcomeFromLog shouldBe true
    // Nothing looked for its tables yet, and nothing measured them.
    closed.getResultsExpiredAt shouldBe null
    closed.getStoredBytes shouldBe null
    // Lists still read the status, which a close leaves as the unit wrote it.
    closed.getStatus shouldBe WorkflowExecutionStatus.Created
  }

  it should "keep when the execution ended, and when its results were marked expired, to the millisecond" in {
    val ended = insertExecution()
    val unstarted = insertExecution()
    val revised = insertExecution()

    ExecutionRecords.close(ended, completed, None, createdAtMs + 42499L, fromLog = true)
    ExecutionRecords.close(
      unstarted,
      failed,
      Some("never started"),
      createdAtMs + 600501L,
      fromLog = false,
      neverStarted = true
    )
    ExecutionRecords.close(revised, failed, Some("unit lost"), createdAtMs + 1L, fromLog = false)
    ExecutionRecords.revise(revised, completed, None, createdAtMs + 90999L)

    record(ended).closing.map(_.endedAtMs) shouldBe Some(createdAtMs + 42499L)
    record(unstarted).closing.map(_.endedAtMs) shouldBe Some(createdAtMs + 600501L)
    row(unstarted).getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 600501L)
    record(revised).closing.map(_.endedAtMs) shouldBe Some(createdAtMs + 90999L)
  }

  it should "record an outcome that says it all with no reason" in {
    val eid = insertExecution()
    ExecutionRecords.close(eid, completed, None, createdAtMs + 1000L, fromLog = true) shouldBe true

    record(eid).closing shouldBe Some(ClosingRecord(completed, None, createdAtMs + 1000L, true))
    row(eid).getOutcomeReason shouldBe null
  }

  it should "close an execution once: a second close changes nothing" in {
    val eid = insertExecution()
    ExecutionRecords.close(
      eid,
      killed,
      Some("killed by the user"),
      createdAtMs + 5000L,
      fromLog = true
    )

    ExecutionRecords.close(
      eid,
      failed,
      Some("unit lost"),
      createdAtMs + 9000L,
      fromLog = false
    ) shouldBe
      false
    ExecutionRecords.close(
      eid,
      failed,
      Some("never started"),
      createdAtMs + 9000L,
      fromLog = false,
      neverStarted = true
    ) shouldBe false

    record(eid).closing shouldBe
      Some(ClosingRecord(killed, Some("killed by the user"), createdAtMs + 5000L, true))
    row(eid).getResultsExpiredAt shouldBe null
  }

  it should "mark the results of an execution that never started expired, with no bytes, in the same statement" in {
    val eid = insertExecution()

    val statements = recorder.record {
      ExecutionRecords.close(
        eid,
        failed,
        Some("never started"),
        createdAtMs + 600000L,
        fromLog = false,
        neverStarted = true
      ) shouldBe true
    }

    statements.map(_.verb) shouldBe Seq("UPDATE")
    val closed = row(eid)
    closed.getOutcome shouldBe failed
    closed.getOutcomeFromLog shouldBe false
    closed.getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 600000L)
    closed.getStoredBytes shouldBe 0L
  }

  it should "close nothing for an id that names no execution" in {
    ExecutionRecords.close(999999999L, failed, None, createdAtMs, fromLog = false) shouldBe false
  }

  it should "refuse an outcome that is no ending, and a never-started execution that ended in its log" in {
    val eid = insertExecution()

    Seq[Short](0, 1, 2, 6, -1).foreach { outcome =>
      withClue(s"outcome $outcome: ") {
        an[IllegalArgumentException] should be thrownBy
          ExecutionRecords.close(eid, outcome, None, createdAtMs, fromLog = false)
        an[IllegalArgumentException] should be thrownBy
          ExecutionRecords.revise(eid, outcome, None, createdAtMs)
      }
    }
    an[IllegalArgumentException] should be thrownBy ExecutionRecords.close(
      eid,
      failed,
      None,
      createdAtMs,
      fromLog = true,
      neverStarted = true
    )
    record(eid).closing shouldBe None
  }

  "ExecutionRecords.setStoredBytes" should "record what the execution's tables hold" in {
    val eid = insertExecution()

    ExecutionRecords.setStoredBytes(eid, 10485760L)
    row(eid).getStoredBytes shouldBe 10485760L
    ExecutionRecords.setStoredBytes(eid, 0L)
    row(eid).getStoredBytes shouldBe 0L
  }

  // --- a verdict gives way to the log ---

  "ExecutionRecords.revise" should "replace a verdict with the log's ending" in {
    val eid = closedByVerdict(createdAtMs + 30000L)

    ExecutionRecords.revise(eid, completed, None, createdAtMs + 90000L) shouldBe true

    record(eid).closing shouldBe Some(ClosingRecord(completed, None, createdAtMs + 90000L, true))
    row(eid).getOutcomeReason shouldBe null
  }

  it should "replace a verdict once" in {
    val eid = closedByVerdict(createdAtMs + 30000L)
    ExecutionRecords.revise(eid, killed, Some("killed by the user"), createdAtMs + 60000L)

    ExecutionRecords.revise(eid, completed, None, createdAtMs + 90000L) shouldBe false

    record(eid).closing shouldBe
      Some(ClosingRecord(killed, Some("killed by the user"), createdAtMs + 60000L, true))
  }

  it should "leave an outcome that is from the log, and an open execution" in {
    val fromLog = insertExecution()
    ExecutionRecords.close(fromLog, failed, Some("boom"), createdAtMs + 5000L, fromLog = true)
    val open = insertExecution()

    ExecutionRecords.revise(fromLog, completed, None, createdAtMs + 9000L) shouldBe false
    ExecutionRecords.revise(open, completed, None, createdAtMs + 9000L) shouldBe false
    ExecutionRecords.revise(999999999L, completed, None, createdAtMs + 9000L) shouldBe false

    record(fromLog).closing shouldBe Some(
      ClosingRecord(failed, Some("boom"), createdAtMs + 5000L, true)
    )
    record(open).closing shouldBe None
  }

  it should "leave an execution whose results are marked expired: one that never started" in {
    val eid = insertExecution()
    ExecutionRecords.close(
      eid,
      failed,
      Some("never started"),
      createdAtMs + 5000L,
      fromLog = false,
      neverStarted = true
    )

    ExecutionRecords.revise(eid, completed, None, createdAtMs + 9000L) shouldBe false

    record(eid).closing shouldBe
      Some(ClosingRecord(failed, Some("never started"), createdAtMs + 5000L, false))
  }

  "ExecutionRecords.closedByVerdictSince" should "list the verdicts at or after a time that still hold their results" in {
    val before = closedByVerdict(createdAtMs + 999L)
    val at = closedByVerdict(createdAtMs + 1000L, "unit terminated")
    val after = closedByVerdict(createdAtMs + 5000L)
    val fromLog = insertExecution()
    ExecutionRecords.close(fromLog, failed, Some("boom"), createdAtMs + 5000L, fromLog = true)
    val neverStarted = insertExecution()
    ExecutionRecords.close(
      neverStarted,
      failed,
      Some("never started"),
      createdAtMs + 5000L,
      fromLog = false,
      neverStarted = true
    )
    val open = insertExecution()
    val revised = closedByVerdict(createdAtMs + 5000L)
    ExecutionRecords.revise(revised, completed, None, createdAtMs + 6000L)

    var verdicts: Seq[ExecutionRecord] = Nil
    val statements = recorder.record {
      verdicts = ExecutionRecords.closedByVerdictSince(createdAtMs + 1000L)
    }

    statements.map(_.verb) shouldBe Seq("SELECT")
    val listed = verdicts.map(_.eid)
    listed should contain inOrder (at, after)
    listed should contain noneOf (before, fromLog, neverStarted, open, revised)
    verdicts.find(_.eid == at).get shouldBe record(at)
    verdicts.find(_.eid == at).get.closing shouldBe
      Some(ClosingRecord(failed, Some("unit terminated"), createdAtMs + 1000L, false))
  }

  it should "read its rows through the index of verdicts, however many executions are closed" in {
    val verdict = closedByVerdict(createdAtMs + 5000L)
    // Two thousand executions that ended in their logs and hold their results: in the index of
    // unexpired executions, and not in the index of verdicts.
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(testWid)))
      .fetchOneInto(classOf[Integer])
    val table = s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}"
    getDSLContext.execute(
      s"""insert into $table (vid, uid, cuid, status, environment_version, starting_time,
         |                    outcome, ended_at, outcome_from_log)
         |select ?, ?, ?, 3, 'test', ?, 3, ?, true from generate_series(1, 2000)""".stripMargin,
      vid,
      Integer.valueOf(creatorUid),
      Integer.valueOf(liveCuid),
      new Timestamp(createdAtMs),
      new Timestamp(createdAtMs + 5000L)
    )
    getDSLContext.execute(s"analyze $table")

    def planOf(read: => Unit): String = {
      val statement = recorder.record(read).head
      getDSLContext
        .fetch(s"explain ${statement.sql}", statement.values.map(_.asInstanceOf[AnyRef]): _*)
        .asScala
        .map(_.get(0).toString)
        .mkString("\n")
    }

    val verdicts = planOf { ExecutionRecords.closedByVerdictSince(createdAtMs) }
    withClue(verdicts) { verdicts should include("idx_workflow_executions_verdict") }
    val open = planOf { ExecutionRecords.open() }
    withClue(open) { open should include("idx_workflow_executions_open") }
    ExecutionRecords.closedByVerdictSince(createdAtMs).map(_.eid) should contain(verdict)
  }

  // --- who may read ---

  "ExecutionRecords.mayRead" should "let the user who created the execution read it" in {
    // Created by a user who was not granted the workflow, such as one who ran a public one.
    val eid = insertExecution(wid = publicWid, uid = strangerUid)

    ExecutionRecords.mayRead(Integer.valueOf(strangerUid), record(eid)) shouldBe true
  }

  it should "let the owner of its workflow and a user the workflow was granted to read it" in {
    val execution = record(insertExecution())

    ExecutionRecords.mayRead(Integer.valueOf(ownerUid), execution) shouldBe true
    ExecutionRecords.mayRead(Integer.valueOf(grantedUid), execution) shouldBe true
  }

  it should "refuse a user with no right to the workflow" in {
    ExecutionRecords.mayRead(Integer.valueOf(strangerUid), record(insertExecution())) shouldBe false
  }

  it should "refuse a user who only sees the workflow because it is public" in {
    val execution = record(insertExecution(wid = publicWid))
    getDSLContext.fetchExists(
      WORKFLOW,
      WORKFLOW.WID.eq(Integer.valueOf(publicWid)).and(WORKFLOW.IS_PUBLIC.isTrue)
    ) shouldBe true

    ExecutionRecords.mayRead(Integer.valueOf(strangerUid), execution) shouldBe false
    ExecutionRecords.mayRead(Integer.valueOf(grantedUid), execution) shouldBe false
    ExecutionRecords.mayRead(Integer.valueOf(ownerUid), execution) shouldBe true
  }
}
