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
      s"""insert into $table (vid, uid, cuid, environment_version, starting_time,
         |                    outcome, ended_at, outcome_from_log)
         |select ?, ?, ?, 'test', ?, 3, ?, true from generate_series(1, 2000)""".stripMargin,
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
    // What the expiry lists by age: the few that ended long ago, among the many that hold results.
    val unexpired = planOf {
      ExecutionRecords.unexpiredEndedBy(createdAtMs - 1L, 0L, 200, warehousesEnabled = false)
    }
    withClue(unexpired) { unexpired should include("idx_workflow_executions_unexpired") }
    ExecutionRecords.closedByVerdictSince(createdAtMs).map(_.eid) should contain(verdict)
  }

  // --- results that expire ---

  private val nextCuid = new AtomicInteger(9860)

  /** A computing unit of the creator's that no other case uses. */
  private def freshUnit(): Int = {
    val cuid = nextCuid.getAndIncrement()
    val unit = new WorkflowComputingUnit
    unit.setCuid(cuid)
    unit.setUid(creatorUid)
    unit.setName(s"execution-records-unit-$cuid")
    unit.setCreationTime(new Timestamp(createdAtMs))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    new WorkflowComputingUnitDao(getDSLContext.configuration()).insert(unit)
    cuid
  }

  /** An execution closed as completed, by its log, as of `endedAtMs`. */
  private def closedAt(
      endedAtMs: Long,
      cuid: Int = liveCuid,
      wid: Int = testWid,
      warehouse: Option[Integer] = None
  ): Long = {
    val eid = insertExecution(wid, Some(cuid), warehouse = warehouse, startedAtMs = endedAtMs)
    ExecutionRecords.close(eid, completed, None, endedAtMs, fromLog = true) shouldBe true
    eid
  }

  /** An execution whose create failed: closed with its results marked expired. */
  private def neverStartedAt(endedAtMs: Long, cuid: Int = liveCuid): Long = {
    val eid = insertExecution(cuid = Some(cuid), startedAtMs = endedAtMs)
    ExecutionRecords.close(
      eid,
      failed,
      Some("never started"),
      endedAtMs,
      fromLog = false,
      neverStarted = true
    ) shouldBe true
    eid
  }

  private def setReplayLog(eid: Long, location: String): Unit =
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, location)
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
      .execute()

  "ExecutionRecords.expire" should "mark the results expired as of a time, to the millisecond, and record what the tables still hold" in {
    val eid = closedAt(createdAtMs + 5000L)
    ExecutionRecords.setStoredBytes(eid, 4096L)

    val statements = recorder.record {
      ExecutionRecords.expire(eid, createdAtMs + 9123L, 512L) shouldBe true
    }

    statements.map(_.verb) shouldBe Seq("UPDATE")
    row(eid).getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 9123L)
    row(eid).getStoredBytes shouldBe 512L
    // How it ended stays as it was.
    record(eid).closing shouldBe Some(ClosingRecord(completed, None, createdAtMs + 5000L, true))
  }

  it should "mark an execution once: a second call changes nothing" in {
    val eid = closedAt(createdAtMs + 5000L)
    ExecutionRecords.expire(eid, createdAtMs + 9000L, 512L) shouldBe true

    ExecutionRecords.expire(eid, createdAtMs + 9999L, 7L) shouldBe false

    row(eid).getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 9000L)
    row(eid).getStoredBytes shouldBe 512L
  }

  it should "leave an open execution, one that never started, and an id that names none" in {
    val open = insertExecution()
    val neverStarted = neverStartedAt(createdAtMs + 5000L)

    ExecutionRecords.expire(open, createdAtMs + 9000L, 1L) shouldBe false
    ExecutionRecords.expire(neverStarted, createdAtMs + 9000L, 1L) shouldBe
      false
    ExecutionRecords.expire(982999L, createdAtMs + 9000L, 1L) shouldBe false

    row(open).getResultsExpiredAt shouldBe null
    row(open).getStoredBytes shouldBe null
    row(neverStarted).getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 5000L)
    row(neverStarted).getStoredBytes shouldBe 0L
  }

  it should "mark by age only an execution that still ended by then, as the row says when it is marked" in {
    val verdict = closedByVerdict(createdAtMs + 5000L)
    // Its unit was back, and its log's ending took the verdict's place, after the pass listed it.
    ExecutionRecords.revise(verdict, completed, None, createdAtMs + 8000L) shouldBe true

    ExecutionRecords.expire(
      verdict,
      createdAtMs + 9000L,
      1L,
      endedByMs = Some(createdAtMs + 7999L)
    ) shouldBe false
    row(verdict).getResultsExpiredAt shouldBe null

    ExecutionRecords.expire(
      verdict,
      createdAtMs + 9000L,
      1L,
      endedByMs = Some(createdAtMs + 8000L)
    ) shouldBe true
    row(verdict).getResultsExpiredAt shouldBe new Timestamp(createdAtMs + 9000L)
  }

  it should "end the time a verdict gives way to its log's ending" in {
    val verdict = closedByVerdict(createdAtMs + 5000L)
    ExecutionRecords.expire(verdict, createdAtMs + 9000L, 1L) shouldBe true

    ExecutionRecords.revise(verdict, completed, None, createdAtMs + 8000L) shouldBe false

    record(verdict).closing shouldBe
      Some(ClosingRecord(failed, Some("unit lost"), createdAtMs + 5000L, false))
    ExecutionRecords.closedByVerdictSince(createdAtMs).map(_.eid) should not contain verdict
  }

  it should "keep naming the execution's replay log" in {
    val eid = closedAt(createdAtMs + 5000L)
    setReplayLog(eid, "file:///tmp/replay/1/")

    ExecutionRecords.expire(eid, createdAtMs + 9000L, 1L) shouldBe true

    row(eid).getLogLocation shouldBe "file:///tmp/replay/1/"
  }

  "ExecutionRecords.forgetReplayLog" should "stop naming the replay log of the execution, and of no other" in {
    val gone = closedAt(createdAtMs + 5000L)
    val kept = closedAt(createdAtMs + 5000L)
    Seq(gone, kept).foreach(setReplayLog(_, "file:///tmp/replay/1/"))

    val statements = recorder.record { ExecutionRecords.forgetReplayLog(gone) }

    statements.map(_.verb) shouldBe Seq("UPDATE")
    row(gone).getLogLocation shouldBe null
    ExecutionRecords.replayLogOf(gone) shouldBe None
    row(kept).getLogLocation shouldBe "file:///tmp/replay/1/"
    // The rest of the row is as it was.
    row(gone).getResultsExpiredAt shouldBe null
    record(gone).closing shouldBe Some(ClosingRecord(completed, None, createdAtMs + 5000L, true))
  }

  "ExecutionRecords.replayLogOf" should "be where the row says the replay log is, and none for a row that names none" in {
    val logged = insertExecution()
    setReplayLog(logged, "file:///tmp/replay/2/")
    val empty = insertExecution()
    setReplayLog(empty, "")

    ExecutionRecords.replayLogOf(logged) shouldBe Some("file:///tmp/replay/2/")
    ExecutionRecords.replayLogOf(empty) shouldBe None
    ExecutionRecords.replayLogOf(insertExecution()) shouldBe None
    ExecutionRecords.replayLogOf(982999L) shouldBe None
  }

  "ExecutionRecords.unexpired" should "find a closed execution that still holds its results, and no other" in {
    val closed = closedAt(createdAtMs + 5000L)
    val expired = closedAt(createdAtMs + 5000L)
    ExecutionRecords.expire(expired, createdAtMs + 9000L, 1L)

    ExecutionRecords.unexpired(closed) shouldBe Some(record(closed))
    ExecutionRecords.unexpired(expired) shouldBe None
    ExecutionRecords.unexpired(insertExecution()) shouldBe None
    ExecutionRecords.unexpired(neverStartedAt(createdAtMs + 5000L)) shouldBe None
    Seq(982999L, 0L, -1L, Int.MaxValue.toLong + 1).foreach { none =>
      withClue(s"$none: ") { ExecutionRecords.unexpired(none) shouldBe None }
    }
  }

  it should "find it by age only if it ended by the time given" in {
    val closed = closedAt(createdAtMs + 5000L)

    ExecutionRecords.unexpired(closed, Some(createdAtMs + 5000L)) shouldBe Some(record(closed))
    ExecutionRecords.unexpired(closed, Some(createdAtMs + 4999L)) shouldBe None
  }

  // Long before any other case's executions ended, so that these are the only ones so old.
  private val longAgoMs = createdAtMs - 30L * 86400000L

  "ExecutionRecords.unexpiredEndedBy" should "list the closed executions that ended by a time and hold their results, oldest first, a batch at a time" in {
    val first = closedAt(longAgoMs + 2000L)
    val second = closedAt(longAgoMs + 1000L)
    val third = closedAt(longAgoMs + 3000L)
    val younger = closedAt(longAgoMs + 3001L)
    val expired = closedAt(longAgoMs + 1000L)
    ExecutionRecords.expire(expired, longAgoMs + 9000L, 1L)
    val neverStarted = neverStartedAt(longAgoMs + 1000L)
    val open = insertExecution(startedAtMs = longAgoMs)
    def listed(afterEid: Long, limit: Int): Seq[Long] =
      ExecutionRecords
        .unexpiredEndedBy(longAgoMs + 3000L, afterEid, limit, warehousesEnabled = false)
        .map(_.eid)

    var all: Seq[ExecutionRecord] = Nil
    val statements = recorder.record {
      all = ExecutionRecords.unexpiredEndedBy(longAgoMs + 3000L, 0L, 10, warehousesEnabled = false)
    }

    statements.map(_.verb) shouldBe Seq("SELECT")
    all.map(_.eid) shouldBe Seq(first, second, third)
    all.map(_.eid) should contain noneOf (younger, expired, neverStarted, open)
    all.head shouldBe record(first)
    listed(afterEid = 0L, limit = 2) shouldBe Seq(first, second)
    listed(afterEid = second, limit = 2) shouldBe Seq(third)
    listed(afterEid = third, limit = 2) shouldBe Nil
  }

  it should "leave out the executions in a per-user warehouse while those are disabled" in {
    val inWarehouse = closedAt(longAgoMs - 5000L, warehouse = Some(whid))
    val inDefault = closedAt(longAgoMs - 5000L)
    def listed(warehousesEnabled: Boolean): Seq[Long] =
      ExecutionRecords.unexpiredEndedBy(longAgoMs - 5000L, 0L, 10, warehousesEnabled).map(_.eid)

    listed(warehousesEnabled = false) shouldBe Seq(inDefault)
    listed(warehousesEnabled = true) shouldBe Seq(inWarehouse, inDefault)
  }

  "ExecutionRecords.unexpiredBefore" should "list the closed executions of the workflow on the unit that hold their results and were made before another, oldest first" in {
    val (unit, otherUnit) = (freshUnit(), freshUnit())
    val first = closedAt(createdAtMs + 5000L, unit)
    val elsewhere = closedAt(createdAtMs + 5000L, otherUnit)
    val otherWorkflows = closedAt(createdAtMs + 5000L, unit, wid = publicWid)
    val expired = closedAt(createdAtMs + 5000L, unit)
    ExecutionRecords.expire(expired, createdAtMs + 9000L, 1L)
    val neverStarted = neverStartedAt(createdAtMs + 5000L, unit)
    val open = insertExecution(cuid = Some(unit))
    val second = closedAt(createdAtMs + 5000L, unit)
    val bound = insertExecution(cuid = Some(unit))
    val later = closedAt(createdAtMs + 5000L, unit)

    var held: Seq[ExecutionRecord] = Nil
    val statements = recorder.record {
      held = ExecutionRecords.unexpiredBefore(testWid, unit, bound)
    }

    statements.map(_.verb) shouldBe Seq("SELECT")
    held.map(_.eid) shouldBe Seq(first, second)
    held.map(
      _.eid
    ) should contain noneOf (elsewhere, otherWorkflows, expired, neverStarted, open, later)
    held.head shouldBe record(first)
  }

  "ExecutionRecords.madeAfter" should "list the executions of the workflow on the unit made after one, up to another, newest first" in {
    val (unit, otherUnit) = (freshUnit(), freshUnit())
    val after = closedAt(createdAtMs + 5000L, unit)
    val closed = closedAt(createdAtMs + 5000L, unit)
    insertExecution(cuid = Some(otherUnit))
    insertExecution(wid = publicWid, cuid = Some(unit))
    val open = insertExecution(cuid = Some(unit))
    val neverStarted = neverStartedAt(createdAtMs + 5000L, unit)
    val upTo = insertExecution(cuid = Some(unit))
    insertExecution(cuid = Some(unit))

    var made: Seq[ExecutionRecord] = Nil
    val statements = recorder.record {
      made = ExecutionRecords.madeAfter(testWid, unit, after, upTo)
    }

    statements.map(_.verb) shouldBe Seq("SELECT")
    made.map(_.eid) shouldBe Seq(upTo, neverStarted, open, closed)
    made.last shouldBe record(closed)
    ExecutionRecords.madeAfter(testWid, unit, upTo, upTo) shouldBe Nil
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
