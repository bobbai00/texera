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

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import com.google.protobuf.timestamp.{Timestamp => ProtoTimestamp}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionAlreadyStartedException,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  ExecutionPlanStore,
  ExecutionTables,
  VFSResourceType,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{ExecutionMode, PortIdentity, WorkflowSettings}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_COMPUTING_UNIT,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_OF_USER,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTerminationReasonEnum.{
  GARBAGE_COLLECTED,
  USER_REQUESTED
}
import org.apache.texera.dao.jooq.generated.enums.{
  UserRoleEnum,
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
import org.apache.texera.dao.{MockTexeraDB, WorkflowExecutionStatus}
import org.apache.texera.web.model.http.request.execution.CreateExecutionRequest
import org.apache.texera.web.service.execution.ExecutionClosing.Settings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}
import org.slf4j.LoggerFactory

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger, AtomicLong}
import java.util.concurrent.{ConcurrentHashMap, ConcurrentLinkedQueue, CountDownLatch}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * The closing job, on real rows and real tables: the rows are in `MockTexeraDB`, and the plans,
  * logs and results are tables of the catalog the build's tests use (the Postgres JDBC catalog
  * in CI), named after this suite's own workflow and executions and dropped after it.
  * Executions are made by [[ExecutionCreator]] unless a case needs a row no create leaves, and
  * what a computing unit would do to one (claim its start, write its log, beat) is done with
  * the stores a unit uses.
  *
  * A case ticks the job itself, on a clock it sets: the clock starts five minutes after the
  * case's rows are made, so a time a "unit" writes into a log lies in the job's past. Every
  * case starts with no execution open and no verdict left to revise.
  */
class ExecutionClosingJobSpec
    extends AnyFlatSpec
    with Matchers
    with Eventually
    with BeforeAndAfterAll
    with MockTexeraDB {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(20, Seconds), interval = Span(50, Millis))

  private val ownerUid = 9821
  private val testWid = 9822
  private val liveCuid = 9823
  private val firstCreatedEid = 982000
  private val nextCuid = new AtomicInteger(9830)

  private val warehouseName = s"user-$ownerUid-spec"
  private var whid: Integer = _

  private val beatEveryMs = 30000L
  private val completed = WorkflowExecutionStatus.Completed
  private val failed = WorkflowExecutionStatus.Failed
  private val killed = WorkflowExecutionStatus.Killed

  private val settings = Settings(
    intervalSeconds = 30,
    lostAfterSeconds = 180,
    neverStartedAfterSeconds = 600,
    reviseVerdictForSeconds = 3600,
    warehousesEnabled = false
  )

  /** The ticks a beat stands still for before its run is lost, under `settings`. */
  private val lostAfterTicks = 6

  private val madePlans = new ConcurrentLinkedQueue[URI]()
  private val madeLogs = new ConcurrentLinkedQueue[URI]()
  private val madeTables = new ConcurrentLinkedQueue[URI]()
  private val nextSeq = new ConcurrentHashMap[URI, java.lang.Long]()

  private val owner: User = {
    val user = new User
    user.setUid(ownerUid)
    user.setName(s"execution-closing-user-$ownerUid")
    user.setEmail(s"execution-closing-$ownerUid@example.com")
    user.setRole(UserRoleEnum.REGULAR)
    user
  }

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()
    new UserDao(cfg).insert(owner)

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName("execution-closing-spec-workflow")
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowDao(cfg).insert(workflow)
    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowVersionDao(cfg).insert(version)
    getDSLContext
      .insertInto(WORKFLOW_OF_USER)
      .set(WORKFLOW_OF_USER.UID, Integer.valueOf(ownerUid))
      .set(WORKFLOW_OF_USER.WID, Integer.valueOf(testWid))
      .execute()

    insertUnit(liveCuid)

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(ownerUid)
    warehouse.setName(warehouseName)
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid

    // The executions made below take ids no other suite's tables are named after.
    getDSLContext.execute(
      "select setval(pg_get_serial_sequence(?, ?), ?, true)",
      executionsTable,
      WORKFLOW_EXECUTIONS.EID.getName,
      Integer.valueOf(firstCreatedEid)
    )
  }

  override protected def afterAll(): Unit =
    try {
      madePlans.asScala.foreach(uri => Try(ExecutionPlanStore.drop(uri)))
      madeLogs.asScala.foreach(uri => Try(ExecutionLogStore.drop(uri)))
      madeTables.asScala.foreach(uri => Try(DocumentFactory.openDocument(uri)._1.clear()))
    } finally {
      closeConnectionPool()
      super.afterAll()
    }

  // --- rows ---

  private def executionsTable: String =
    s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}"

  private def insertUnit(cuid: Int): Unit = {
    val unit = new WorkflowComputingUnit
    unit.setCuid(cuid)
    unit.setUid(ownerUid)
    unit.setName(s"execution-closing-unit-$cuid")
    unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    new WorkflowComputingUnitDao(getDSLContext.configuration()).insert(unit)
  }

  /** A computing unit of the owner's that no other case uses. */
  private def freshUnit(): Int = {
    val cuid = nextCuid.getAndIncrement()
    insertUnit(cuid)
    cuid
  }

  /** Stamps a unit's row terminated, as the unit manager does. */
  private def terminate(cuid: Int, reason: WorkflowComputingUnitTerminationReasonEnum): Unit =
    getDSLContext
      .update(WORKFLOW_COMPUTING_UNIT)
      .set(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME, new Timestamp(System.currentTimeMillis()))
      .set(WORKFLOW_COMPUTING_UNIT.TERMINATION_REASON, reason)
      .where(WORKFLOW_COMPUTING_UNIT.CUID.eq(Integer.valueOf(cuid)))
      .execute()

  /** Closes what earlier cases left open, and leaves none of their verdicts to revise. */
  private def settle(): Unit =
    getDSLContext.execute(
      s"""update $executionsTable
         |set outcome = coalesce(outcome, 5),
         |    ended_at = coalesce(ended_at, starting_time),
         |    outcome_from_log = true""".stripMargin
    )

  private def row(execution: ExecutionRecord): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration())
      .fetchOneByEid(Integer.valueOf(execution.eid.toInt))

  private def record(eid: Long): ExecutionRecord =
    ExecutionRecords.find(eid).getOrElse(fail(s"execution $eid has no row"))

  private def closingOf(execution: ExecutionRecord): Option[ClosingRecord] =
    record(execution.eid).closing

  // --- executions ---

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def plan(scan: LogicalOp): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(scan, "scan"),
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search")
      ),
      List(
        LogicalLink(
          OperatorIdentity("scan"),
          PortIdentity(),
          OperatorIdentity("search"),
          PortIdentity()
        )
      ),
      List.empty,
      List.empty
    )

  private def request(cuid: Int, plan: LogicalPlanPojo): CreateExecutionRequest =
    CreateExecutionRequest(
      wid = testWid,
      executionName = "closing-spec-execution",
      engineVersion = "1.4.0-spec",
      logicalPlan = plan,
      workflowSettings = Some(WorkflowSettings(77, ExecutionMode.MATERIALIZED)),
      emailNotificationEnabled = false,
      computingUnitId = cuid,
      warehouseId = None,
      replayFromExecution = None,
      targetOperatorId = None
    )

  /** Creates as the Dashboard does, bound to the fixture files; nothing is cleared afterwards. */
  private val creator = new ExecutionCreator(
    bindingsFor = _ => TestUtils.fixtureBindings,
    replayLogRoot = None,
    warehousesEnabled = false,
    costHints = new CostHintsLoader(1) {
      override def load(wid: Long, uid: Int) = None
    },
    background = _ => ()
  )

  private val requestUri = new URI("http://texera.example:4200/api/executions")

  /** An execution as its create leaves it: an open row, and a stored plan no unit has started. */
  private def created(cuid: Int = liveCuid): ExecutionRecord = {
    val response =
      creator.create(request(cuid, plan(TestOperators.smallCsvScanOpDesc())), owner, requestUri)
    madePlans.add(new URI(response.planUri))
    record(response.eid)
  }

  /** An execution whose workflow does not compile, which its create closed itself. */
  private def notCompiled(): ExecutionRecord = {
    val refused = intercept[WorkflowNotCompiled] {
      creator.create(request(liveCuid, plan(new CSVScanSourceOpDesc())), owner, requestUri)
    }
    record(refused.eid)
  }

  /**
    * A row with no plan, as a create that died between its insert and its plan's write leaves
    * one, or of an execution in a warehouse.
    */
  private def inserted(warehouse: Option[Integer] = None): ExecutionRecord = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(testWid)))
      .fetchOneInto(classOf[Integer])
    val eid = getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(ownerUid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(liveCuid))
      .set(WORKFLOW_EXECUTIONS.STATUS, Short.box(WorkflowExecutionStatus.Created))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, new Timestamp(System.currentTimeMillis()))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.WHID, warehouse.orNull)
      .returning(WORKFLOW_EXECUTIONS.EID)
      .fetchOne()
      .getEid
    record(eid.longValue())
  }

  /** Makes the log of `execution`, as its unit does when it starts the run: no row, a first beat. */
  private def withLog(execution: ExecutionRecord): ExecutionRecord = {
    ExecutionLogStore.create(execution.logUri, execution.startingTimeMs + 1000L, beatEveryMs)
    madeLogs.add(execution.logUri)
    execution
  }

  /** A created execution that a unit started: its start is claimed and its log made. */
  private def started(cuid: Int = liveCuid): ExecutionRecord = {
    val execution = created(cuid)
    ExecutionPlanStore.claimStart(execution.planUri)
    withLog(execution)
  }

  /** Appends a row to the log of `execution`, `afterMs` after it was created; the beat is then. */
  private def append(
      execution: ExecutionRecord,
      state: String,
      afterMs: Long,
      reason: Option[String] = None,
      errors: Seq[WorkflowFatalError] = Nil
  ): Unit = {
    val seq = nextSeq.merge(execution.logUri, 1L, (last, one) => last + one)
    val atMs = execution.startingTimeMs + afterMs
    ExecutionLogStore.append(
      execution.logUri,
      Seq(ExecutionLogEntry.state(seq, atMs, state, reason, errors)),
      atMs
    )
  }

  /** A started execution whose run is under way. */
  private def running(cuid: Int = liveCuid): ExecutionRecord = {
    val execution = started(cuid)
    append(execution, "READY", 2000L)
    append(execution, "RUNNING", 3000L)
    execution
  }

  private def beat(execution: ExecutionRecord, afterMs: Long): Unit =
    ExecutionLogStore.beat(execution.logUri, execution.startingTimeMs + afterMs)

  private def error(message: String): WorkflowFatalError =
    WorkflowFatalError(
      EXECUTION_FAILURE,
      ProtoTimestamp(1794873600L, 0),
      message,
      "<trace>",
      "op",
      "w"
    )

  /** Gives `execution` a result table with `rows` rows, where its plan stores a port. */
  private def withResult(execution: ExecutionRecord, rows: Int): URI = {
    val uri = ExecutionTables
      .portTables(execution.planUri)
      .find(VFSURIFactory.decodeURI(_).resourceType == VFSResourceType.RESULT)
      .getOrElse(fail(s"the plan of execution ${execution.eid} names no port"))
    val schema = Schema().add("line", AttributeType.STRING)
    val document =
      DocumentFactory.createDocument(uri, schema).asInstanceOf[VirtualDocument[Tuple]]
    madeTables.add(uri)
    val writer = document.writer(UUID.randomUUID().toString)
    writer.open()
    (1 to rows).foreach(line => writer.putOne(Tuple(schema, Array[Any](s"line $line"))))
    writer.close()
    uri
  }

  // --- the job ---

  private class Outage extends RuntimeException("the lake is out of reach")

  /**
    * A job under test and what it is made of. Its lake calls are the stores', unless a case
    * replaces one; each label read and each measuring is noted. Making one closes what earlier
    * cases left open and settles their verdicts, unless it is to keep them.
    */
  private class Fixture(
      jobSettings: Settings = settings,
      label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
      rows: URI => Seq[ExecutionLogEntry] = ExecutionLogStore.read,
      isStarted: URI => Boolean = ExecutionPlanStore.isStarted,
      claimStart: URI => Unit = ExecutionPlanStore.claimStart,
      storedBytes: ExecutionRecord => Long = ExecutionCloser.storedBytesOf,
      open: () => Seq[ExecutionRecord] = () => ExecutionRecords.open(),
      lookLimit: FiniteDuration = ExecutionClosingJob.LookLimit,
      keepVerdicts: Boolean = false
  ) {
    if (!keepVerdicts) settle()

    /** The Dashboard's clock: five minutes after the fixture, and its rows, were made. */
    val clock = new AtomicLong(System.currentTimeMillis() + 300000L)
    val labelsRead = new ConcurrentLinkedQueue[URI]()
    val measured = new ConcurrentLinkedQueue[Long]()

    val closer = new ExecutionCloser(
      label = uri => {
        labelsRead.add(uri)
        label(uri)
      },
      rows = rows,
      isStarted = isStarted,
      claimStart = claimStart,
      storedBytes = execution => {
        measured.add(execution.eid)
        storedBytes(execution)
      },
      now = () => clock.get()
    )
    val job = new ExecutionClosingJob(
      settings = jobSettings,
      closer = closer,
      openExecutions = open,
      lookLimit = lookLimit,
      now = () => clock.get()
    )

    def tick(times: Int = 1): Unit = (1 to times).foreach(_ => job.tick())

    def readLabelOf(execution: ExecutionRecord): Boolean =
      labelsRead.asScala.exists(_ == execution.logUri)
  }

  /** Runs `body`, and answers the level and the message of every line the closer logged. */
  private def logged(body: => Unit): Seq[(Level, String)] = {
    val logger = LoggerFactory.getLogger(classOf[ExecutionCloser]).asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val level = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.ALL)
    try {
      body
      appender.list.asScala.toList.map(event => (event.getLevel, event.getFormattedMessage))
    } finally {
      logger.setLevel(level)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  /** Runs each of `bodies` on a thread of its own, all at once, and waits for them. */
  private def atOnce(bodies: (() => Unit)*): Unit = {
    val go = new CountDownLatch(1)
    val failures = new ConcurrentLinkedQueue[Throwable]()
    val threads = bodies.map { body =>
      val thread = new Thread(() => {
        go.await()
        try body()
        catch { case failure: Throwable => failures.add(failure) }
      })
      thread.start()
      thread
    }
    go.countDown()
    threads.foreach(_.join(60000L))
    failures.asScala.toList shouldBe Nil
  }

  // --- an ending in the log ---

  "ExecutionClosingJob" should "close an execution whose log ended with the log's state, reason and time" in {
    val fixture = new Fixture()
    val ranToTheEnd = running()
    append(ranToTheEnd, "COMPLETED", 9321L)
    val broke = running()
    append(broke, "FAILED", 7000L, errors = Seq(error("java.lang.RuntimeException: boom")))
    val stopped = running()
    append(stopped, "KILLED", 5000L, reason = Some("killed by the user"))

    fixture.tick()

    closingOf(ranToTheEnd) shouldBe
      Some(ClosingRecord(completed, None, ranToTheEnd.startingTimeMs + 9321L, fromLog = true))
    closingOf(broke) shouldBe Some(
      ClosingRecord(
        failed,
        Some("java.lang.RuntimeException: boom"),
        broke.startingTimeMs + 7000L,
        fromLog = true
      )
    )
    closingOf(stopped) shouldBe Some(
      ClosingRecord(
        killed,
        Some("killed by the user"),
        stopped.startingTimeMs + 5000L,
        fromLog = true
      )
    )
    // Its results are there to be read, and expired later.
    row(ranToTheEnd).getResultsExpiredAt shouldBe null
    // Lists still read the status column, which a close does not write.
    row(broke).getStatus shouldBe WorkflowExecutionStatus.Created
  }

  it should "leave a run that is under way open, tick after tick, while its unit beats" in {
    val fixture = new Fixture()
    val execution = running()

    (1 to 12).foreach { tick =>
      beat(execution, 3000L + tick * 30000L)
      fixture.tick()
      withClue(s"tick $tick: ") { closingOf(execution) shouldBe None }
    }
  }

  it should "log one line for an execution it closes, and none for one it leaves" in {
    val fixture = new Fixture()
    val ended = running()
    append(ended, "COMPLETED", 9000L)
    running()

    val lines = logged { fixture.tick(2) }

    lines shouldBe Seq(
      (
        Level.INFO,
        s"Execution ${ended.eid} of workflow $testWid is closed as completed, as its log says."
      )
    )
  }

  it should "close an ended execution in a warehouse, when warehouses are enabled" in {
    val fixture = new Fixture(settings.copy(warehousesEnabled = true))
    val execution = withLog(inserted(warehouse = Some(whid)))
    execution.logUri.toString should include(s"/wh/$warehouseName/")
    append(execution, "COMPLETED", 9000L)

    fixture.tick()

    closingOf(execution) shouldBe
      Some(ClosingRecord(completed, None, execution.startingTimeMs + 9000L, fromLog = true))
  }

  // --- a unit that is gone ---

  it should "close the run of a terminated unit on the first tick: 'unit terminated' by its user, else 'unit lost'" in {
    val fixture = new Fixture()
    val (userUnit, sweptUnit) = (freshUnit(), freshUnit())
    val byUser = running(userUnit)
    beat(byUser, 40567L)
    val swept = running(sweptUnit)
    terminate(userUnit, USER_REQUESTED)
    terminate(sweptUnit, GARBAGE_COLLECTED)

    fixture.tick()

    // As of the unit's last sign of life: its last beat, or the append that was its last write.
    closingOf(byUser) shouldBe Some(
      ClosingRecord(
        failed,
        Some("unit terminated"),
        byUser.startingTimeMs + 40567L,
        fromLog = false
      )
    )
    closingOf(swept) shouldBe
      Some(ClosingRecord(failed, Some("unit lost"), swept.startingTimeMs + 3000L, fromLog = false))
    row(swept).getResultsExpiredAt shouldBe null
  }

  it should "close an execution its terminated unit never started, and take its start" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val execution = created(unit)
    terminate(unit, USER_REQUESTED)

    fixture.tick()

    closingOf(execution) shouldBe
      Some(ClosingRecord(failed, Some("unit terminated"), fixture.clock.get(), fromLog = false))
    // Nothing starts an execution that is recorded as over.
    ExecutionPlanStore.isStarted(execution.planUri) shouldBe true
    an[ExecutionAlreadyStartedException] should be thrownBy
      ExecutionPlanStore.claimStart(execution.planUri)
  }

  it should "close a run whose beat stood still as 'unit lost' after the threshold, and not one tick sooner" in {
    val fixture = new Fixture()
    val execution = running()
    beat(execution, 45000L)

    // The tick that first sees the beat, and one fewer than the threshold that see it unchanged.
    fixture.tick(lostAfterTicks)
    closingOf(execution) shouldBe None

    fixture.tick()
    closingOf(execution) shouldBe
      Some(
        ClosingRecord(failed, Some("unit lost"), execution.startingTimeMs + 45000L, fromLog = false)
      )
  }

  it should "start counting again when a beat moves" in {
    val fixture = new Fixture()
    val execution = running()

    fixture.tick(lostAfterTicks)
    beat(execution, 60000L)
    fixture.tick(lostAfterTicks)
    closingOf(execution) shouldBe None

    fixture.tick()
    closingOf(execution).map(_.reason) shouldBe Some(Some("unit lost"))
  }

  it should "lose a started execution whose unit never made its log, as of now" in {
    val fixture = new Fixture()
    val execution = created()
    ExecutionPlanStore.claimStart(execution.planUri)

    fixture.tick(lostAfterTicks)
    closingOf(execution) shouldBe None

    fixture.tick()
    closingOf(execution) shouldBe
      Some(ClosingRecord(failed, Some("unit lost"), fixture.clock.get(), fromLog = false))
  }

  it should "forget what it saw of an execution that is no longer open" in {
    val shown = new AtomicBoolean(true)
    val fixture = new Fixture(open = () => if (shown.get()) ExecutionRecords.open() else Nil)
    val execution = running()

    fixture.tick(lostAfterTicks)
    shown.set(false)
    fixture.tick()
    shown.set(true)
    // Counted from nothing again: with what it had counted, this tick would lose the run.
    fixture.tick(lostAfterTicks)
    closingOf(execution) shouldBe None

    fixture.tick()
    closingOf(execution).map(_.reason) shouldBe Some(Some("unit lost"))
  }

  it should "close with an ending in the log's rows that the label read did not show yet" in {
    // The label as it was while the run was under way: read just before the unit's last row.
    val stale = new ConcurrentHashMap[URI, ExecutionLabel]()
    val fixture =
      new Fixture(label = uri => Option(stale.get(uri)).orElse(ExecutionLogStore.label(uri)))
    val unit = freshUnit()
    val terminated = running(unit)
    val silent = running()
    Seq(terminated, silent).foreach { execution =>
      stale.put(execution.logUri, ExecutionLogStore.label(execution.logUri).get)
    }
    append(terminated, "COMPLETED", 9000L)
    append(silent, "KILLED", 8000L, reason = Some("stopped: nobody watched it for 30 s"))
    terminate(unit, GARBAGE_COLLECTED)

    fixture.tick()
    closingOf(terminated) shouldBe
      Some(ClosingRecord(completed, None, terminated.startingTimeMs + 9000L, fromLog = true))
    closingOf(silent) shouldBe None

    fixture.tick(lostAfterTicks)
    closingOf(silent) shouldBe Some(
      ClosingRecord(
        killed,
        Some("stopped: nobody watched it for 30 s"),
        silent.startingTimeMs + 8000L,
        fromLog = true
      )
    )
  }

  // --- a lake that cannot be read ---

  it should "close nothing while the label cannot be read, however long, and count none of those ticks" in {
    val outage = new AtomicBoolean(true)
    val fixture = new Fixture(label = uri => {
      if (outage.get()) throw new Outage
      ExecutionLogStore.label(uri)
    })
    val unit = freshUnit()
    val watched = running()
    val neverStarted = created()
    val ofTerminatedUnit = running(unit)
    val ended = running()
    append(ended, "COMPLETED", 9000L)
    terminate(unit, USER_REQUESTED)
    // Older than every limit.
    fixture.clock.addAndGet(24L * 3600 * 1000)

    fixture.tick(10)
    Seq(watched, neverStarted, ofTerminatedUnit, ended).foreach { execution =>
      withClue(s"execution ${execution.eid}: ") { closingOf(execution) shouldBe None }
    }

    // The lake answers again: each is decided as if the job had only now begun to look.
    outage.set(false)
    fixture.tick()
    closingOf(ended).map(_.outcome) shouldBe Some(completed)
    closingOf(ofTerminatedUnit).map(_.reason) shouldBe Some(Some("unit terminated"))
    closingOf(neverStarted).map(_.reason) shouldBe Some(Some("never started"))
    closingOf(watched) shouldBe None
    fixture.tick(lostAfterTicks - 1)
    closingOf(watched) shouldBe None
    fixture.tick()
    closingOf(watched).map(_.reason) shouldBe Some(Some("unit lost"))
  }

  it should "not count a tick whose read failed among the ticks a beat stood still" in {
    val outage = new AtomicBoolean(false)
    val fixture = new Fixture(label = uri => {
      if (outage.get()) throw new Outage
      ExecutionLogStore.label(uri)
    })
    val execution = running()

    fixture.tick(3)
    outage.set(true)
    fixture.tick(10)
    outage.set(false)
    // Three ticks saw the beat before the outage: three more are short of the threshold.
    fixture.tick(lostAfterTicks - 3)
    closingOf(execution) shouldBe None

    fixture.tick()
    closingOf(execution).map(_.reason) shouldBe Some(Some("unit lost"))
  }

  it should "not close an execution as never started while its plan's start claim cannot be read" in {
    val outage = new AtomicBoolean(true)
    val fixture = new Fixture(isStarted = uri => {
      if (outage.get()) throw new Outage
      ExecutionPlanStore.isStarted(uri)
    })
    val execution = created()
    fixture.clock.addAndGet(24L * 3600 * 1000)

    fixture.tick(10)
    closingOf(execution) shouldBe None

    outage.set(false)
    fixture.tick()
    closingOf(execution).map(_.reason) shouldBe Some(Some("never started"))
  }

  it should "not close an execution as never started while its start cannot be claimed" in {
    val outage = new AtomicBoolean(true)
    val fixture = new Fixture(claimStart = uri => {
      if (outage.get()) throw new Outage
      ExecutionPlanStore.claimStart(uri)
    })
    val execution = created()
    fixture.clock.addAndGet(24L * 3600 * 1000)

    fixture.tick(10)
    closingOf(execution) shouldBe None
    ExecutionPlanStore.isStarted(execution.planUri) shouldBe false

    outage.set(false)
    fixture.tick()
    closingOf(execution).map(_.reason) shouldBe Some(Some("never started"))
  }

  it should "not lose a run while the rows of its log cannot be read" in {
    val outage = new AtomicBoolean(true)
    val fixture = new Fixture(rows = uri => {
      if (outage.get()) throw new Outage
      ExecutionLogStore.read(uri)
    })
    val unit = freshUnit()
    val ofTerminatedUnit = running(unit)
    val silent = running()
    terminate(unit, GARBAGE_COLLECTED)
    fixture.clock.addAndGet(24L * 3600 * 1000)

    fixture.tick(lostAfterTicks + 10)
    closingOf(ofTerminatedUnit) shouldBe None
    closingOf(silent) shouldBe None

    outage.set(false)
    fixture.tick()
    closingOf(ofTerminatedUnit).map(_.reason) shouldBe Some(Some("unit lost"))
    closingOf(silent).map(_.reason) shouldBe Some(Some("unit lost"))
  }

  it should "go on to the other executions when the look at one fails or takes too long" in {
    val slow = new AtomicBoolean(true)
    lazy val stuck: ExecutionRecord = running()
    lazy val broken: ExecutionRecord = running()
    val fixture = new Fixture(
      label = uri => {
        if (slow.get() && uri == stuck.logUri) Thread.sleep(30000L)
        if (slow.get() && uri == broken.logUri) throw new Outage
        ExecutionLogStore.label(uri)
      },
      lookLimit = 3.seconds
    )
    val quick = running()
    Seq(stuck, broken, quick).foreach(append(_, "COMPLETED", 9000L))

    fixture.tick()
    closingOf(quick).map(_.outcome) shouldBe Some(completed)
    closingOf(stuck) shouldBe None
    closingOf(broken) shouldBe None

    // Looked at again on the next tick.
    slow.set(false)
    fixture.tick()
    closingOf(stuck).map(_.outcome) shouldBe Some(completed)
    closingOf(broken).map(_.outcome) shouldBe Some(completed)
  }

  it should "look at more executions than it looks at at once" in {
    val fixture = new Fixture()
    val executions = (1 to ExecutionClosingJob.Concurrency + 3).map(_ => withLog(inserted()))
    executions.foreach(append(_, "COMPLETED", 9000L))

    fixture.tick()

    executions.map(closingOf(_).map(_.outcome)) shouldBe executions.map(_ => Some(completed))
  }

  it should "survive a tick whose rows cannot be read, as the scheduler runs it" in {
    val fixture = new Fixture(open = () => throw new IllegalStateException("the database is down"))

    an[IllegalStateException] should be thrownBy fixture.job.tick()
    noException should be thrownBy fixture.job.runScheduledTick()
  }

  // --- never started ---

  it should "claim and close an execution no unit started within the limit, and not before" in {
    val fixture = new Fixture()
    val execution = created()

    fixture.clock.set(execution.startingTimeMs + 599999L)
    fixture.tick(3)
    closingOf(execution) shouldBe None
    ExecutionPlanStore.isStarted(execution.planUri) shouldBe false

    fixture.clock.set(execution.startingTimeMs + 600000L)
    fixture.tick()
    closingOf(execution) shouldBe
      Some(
        ClosingRecord(
          failed,
          Some("never started"),
          execution.startingTimeMs + 600000L,
          fromLog = false
        )
      )
    // No unit made a table for it: there is nothing to expire, and only its plan to measure.
    val closed = row(execution)
    closed.getResultsExpiredAt shouldBe new Timestamp(execution.startingTimeMs + 600000L)
    closed.getStoredBytes shouldBe ExecutionTables.storedBytes(execution.planUri)
    closed.getStoredBytes.longValue() should be > 0L
    // Nobody can start an execution the record says was never started.
    an[ExecutionAlreadyStartedException] should be thrownBy
      ExecutionPlanStore.claimStart(execution.planUri)
  }

  it should "leave an execution whose start a unit claimed first" in {
    // The tick read the plan before the unit claimed its start, and claims after.
    val readEarly = new AtomicBoolean(true)
    val fixture =
      new Fixture(isStarted = uri => !readEarly.get() && ExecutionPlanStore.isStarted(uri))
    val execution = created()
    ExecutionPlanStore.claimStart(execution.planUri)
    fixture.clock.set(execution.startingTimeMs + 900000L)

    fixture.tick()
    closingOf(execution) shouldBe None

    // From then on it is a started execution like any other.
    readEarly.set(false)
    withLog(execution)
    append(execution, "COMPLETED", 9000L)
    fixture.tick()
    closingOf(execution).map(_.outcome) shouldBe Some(completed)
  }

  it should "close an old execution with no plan table at all as never started" in {
    val fixture = new Fixture()
    val execution = inserted()

    fixture.tick()
    closingOf(execution) shouldBe None

    fixture.clock.set(execution.startingTimeMs + 600000L)
    fixture.tick()
    closingOf(execution) shouldBe
      Some(
        ClosingRecord(
          failed,
          Some("never started"),
          execution.startingTimeMs + 600000L,
          fromLog = false
        )
      )
    row(execution).getStoredBytes shouldBe 0L
    row(execution).getResultsExpiredAt should not be null
  }

  // --- a warehouse that cannot be reached ---

  it should "close an execution in a per-user warehouse while those are disabled, reading nothing of it" in {
    val fixture = new Fixture()
    val execution = inserted(warehouse = Some(whid))

    fixture.tick()

    closingOf(execution) shouldBe Some(
      ClosingRecord(
        failed,
        Some("its warehouse is no longer available"),
        fixture.clock.get(),
        fromLog = false
      )
    )
    fixture.labelsRead.asScala shouldBe empty
    fixture.measured.asScala shouldBe empty
    row(execution).getStoredBytes shouldBe null
    row(execution).getResultsExpiredAt shouldBe null
  }

  it should "close an execution whose warehouse was deleted, while warehouses are enabled" in {
    val fixture = new Fixture(settings.copy(warehousesEnabled = true))
    // The row names no warehouse: what deleting its warehouse leaves.
    val execution = running()

    fixture.tick()

    closingOf(execution).map(_.reason) shouldBe Some(Some("its warehouse is no longer available"))
    fixture.readLabelOf(execution) shouldBe false
  }

  // --- a unit's clock ---

  it should "keep an ending's time between the execution's creation and now" in {
    val fixture = new Fixture()
    val ahead = running()
    append(ahead, "COMPLETED", 3600000L + 300000L)
    val behind = running()
    append(behind, "COMPLETED", -3600000L)

    fixture.tick()

    closingOf(ahead) shouldBe Some(
      ClosingRecord(completed, None, fixture.clock.get(), fromLog = true)
    )
    closingOf(behind) shouldBe
      Some(ClosingRecord(completed, None, behind.startingTimeMs, fromLog = true))
  }

  it should "keep a lost unit's last beat between the execution's creation and now" in {
    val fixture = new Fixture()
    val (aheadUnit, behindUnit) = (freshUnit(), freshUnit())
    val ahead = running(aheadUnit)
    beat(ahead, 3600000L + 300000L)
    val behind = running(behindUnit)
    beat(behind, -3600000L)
    terminate(aheadUnit, GARBAGE_COLLECTED)
    terminate(behindUnit, GARBAGE_COLLECTED)

    fixture.tick()

    closingOf(ahead) shouldBe
      Some(ClosingRecord(failed, Some("unit lost"), fixture.clock.get(), fromLog = false))
    closingOf(behind) shouldBe
      Some(ClosingRecord(failed, Some("unit lost"), behind.startingTimeMs, fromLog = false))
  }

  // --- what a closed execution holds ---

  it should "record what the execution's tables hold: its plan, its log and each stored port" in {
    val fixture = new Fixture()
    val execution = running()
    val result = withResult(execution, rows = 200)
    append(execution, "COMPLETED", 9000L)

    fixture.tick()

    val parts = Seq(execution.planUri, execution.logUri, result).map(ExecutionTables.storedBytes)
    parts.foreach(_ should be > 0L)
    row(execution).getStoredBytes shouldBe parts.sum
    fixture.measured.asScala.toList shouldBe List(execution.eid)
  }

  it should "close an execution whose tables cannot be measured, with no bytes recorded" in {
    val fixture = new Fixture(storedBytes = _ => throw new Outage)
    val execution = running()
    append(execution, "COMPLETED", 9000L)

    val lines = logged { fixture.tick() }

    closingOf(execution).map(_.outcome) shouldBe Some(completed)
    row(execution).getStoredBytes shouldBe null
    lines.map(_._1) shouldBe Seq(Level.INFO, Level.WARN)
    lines.last._2 should include(
      s"execution ${execution.eid} holds in the lake could not be measured"
    )
  }

  // --- several Dashboards ---

  it should "close each execution once when two jobs run on one database" in {
    val (one, other) = (new Fixture(), new Fixture())
    val executions = (1 to 6).map(_ => withLog(inserted()))
    executions.foreach(append(_, "COMPLETED", 9000L))

    val lines = logged { atOnce(() => one.tick(), () => other.tick()) }

    executions.foreach { execution =>
      closingOf(execution).map(_.outcome) shouldBe Some(completed)
      // Only the job whose UPDATE closed it went on to measure it and to log it.
      (one.measured.asScala ++ other.measured.asScala).count(_ == execution.eid) shouldBe 1
      lines.count(_._2.startsWith(s"Execution ${execution.eid} of workflow")) shouldBe 1
    }
  }

  // --- closing on request ---

  "ExecutionCloser.closeIfEnded" should "close an execution whose label shows an ending, and no other" in {
    val fixture = new Fixture()
    val ended = running()
    append(ended, "KILLED", 9000L, reason = Some("replaced by execution 7"))
    val underWay = running()
    val unstarted = created()

    fixture.closer.closeIfEnded(ended) shouldBe true
    fixture.closer.closeIfEnded(ended) shouldBe false
    fixture.closer.closeIfEnded(underWay) shouldBe false
    fixture.closer.closeIfEnded(unstarted) shouldBe false

    closingOf(ended) shouldBe Some(
      ClosingRecord(
        killed,
        Some("replaced by execution 7"),
        ended.startingTimeMs + 9000L,
        fromLog = true
      )
    )
    closingOf(underWay) shouldBe None
    closingOf(unstarted) shouldBe None
    fixture.measured.asScala.toList shouldBe List(ended.eid)
  }

  // --- a verdict gives way to the log ---

  /** A run the job closed as lost though its unit was only cut off: its beat stood still. */
  private def lost(fixture: Fixture): ExecutionRecord = {
    val execution = running()
    fixture.tick(lostAfterTicks + 1)
    closingOf(execution) shouldBe
      Some(
        ClosingRecord(failed, Some("unit lost"), execution.startingTimeMs + 3000L, fromLog = false)
      )
    execution
  }

  "A verdict" should "give way to the ending the log shows later" in {
    val fixture = new Fixture()
    val execution = lost(fixture)
    val bytesAtVerdict = row(execution).getStoredBytes.longValue()

    // The unit is back: it writes what it had kept, and the run ends.
    withResult(execution, rows = 200)
    append(execution, "COMPLETED", 200000L)
    val lines = logged { fixture.tick() }

    closingOf(execution) shouldBe
      Some(ClosingRecord(completed, None, execution.startingTimeMs + 200000L, fromLog = true))
    row(execution).getOutcomeReason shouldBe null
    // Measured again: the run went on writing after the verdict.
    row(execution).getStoredBytes.longValue() should be > bytesAtVerdict
    lines shouldBe Seq(
      (
        Level.INFO,
        s"Execution ${execution.eid} of workflow $testWid, closed as failed (unit lost), ended " +
          "as completed by its log, which is recorded in the verdict's place."
      )
    )

    // And it is settled: nothing reads its log again.
    fixture.labelsRead.clear()
    fixture.tick(2)
    fixture.readLabelOf(execution) shouldBe false
  }

  it should "give way to a failure or a kill the log shows, with its reason" in {
    val fixture = new Fixture()
    val (broke, stopped) = (lost(fixture), lost(fixture))

    append(broke, "FAILED", 150000L, errors = Seq(error("the lake came back too late")))
    append(stopped, "KILLED", 160000L, reason = Some("killed by the user"))
    fixture.tick()

    closingOf(broke) shouldBe Some(
      ClosingRecord(
        failed,
        Some("the lake came back too late"),
        broke.startingTimeMs + 150000L,
        fromLog = true
      )
    )
    closingOf(stopped) shouldBe Some(
      ClosingRecord(
        killed,
        Some("killed by the user"),
        stopped.startingTimeMs + 160000L,
        fromLog = true
      )
    )
  }

  it should "stand while the label shows no ending, though the unit is back" in {
    val fixture = new Fixture()
    val execution = lost(fixture)
    val verdict = closingOf(execution)

    (1 to 5).foreach { tick =>
      beat(execution, 200000L + tick * 30000L)
      fixture.labelsRead.clear()
      fixture.tick()
      // Read on every tick, and left.
      fixture.readLabelOf(execution) shouldBe true
      closingOf(execution) shouldBe verdict
    }
    append(execution, "PAUSED", 400000L)
    fixture.tick()
    closingOf(execution) shouldBe verdict
  }

  it should "stand once the window has passed, with its log no longer read" in {
    val fixture = new Fixture()
    val execution = lost(fixture)
    val verdict = closingOf(execution)
    append(execution, "COMPLETED", 200000L)

    // One millisecond past the hour since the execution ended.
    fixture.clock.set(verdict.get.endedAtMs + 3600001L)
    fixture.labelsRead.clear()
    fixture.tick(3)
    fixture.readLabelOf(execution) shouldBe false
    closingOf(execution) shouldBe verdict

    // On the hour, it is still looked at.
    fixture.clock.set(verdict.get.endedAtMs + 3600000L)
    fixture.tick()
    closingOf(execution).map(_.outcome) shouldBe Some(completed)
  }

  it should "stand while the log cannot be read, and give way once it can" in {
    val outage = new AtomicBoolean(false)
    val fixture = new Fixture(label = uri => {
      if (outage.get()) throw new Outage
      ExecutionLogStore.label(uri)
    })
    val execution = lost(fixture)
    val verdict = closingOf(execution)
    append(execution, "COMPLETED", 200000L)

    outage.set(true)
    fixture.tick(5)
    closingOf(execution) shouldBe verdict

    outage.set(false)
    fixture.tick()
    closingOf(execution).map(_.outcome) shouldBe Some(completed)
  }

  it should "be replaced once when two jobs run on one database" in {
    val (one, other) = (new Fixture(), new Fixture())
    val unit = freshUnit()
    val executions = (1 to 6).map(_ => running(unit))
    terminate(unit, GARBAGE_COLLECTED)
    one.tick()
    executions.foreach(closingOf(_).map(_.fromLog) shouldBe Some(false))
    one.measured.clear()

    executions.foreach(append(_, "COMPLETED", 200000L))
    val lines = logged { atOnce(() => one.tick(), () => other.tick()) }

    executions.foreach { execution =>
      closingOf(execution) shouldBe
        Some(ClosingRecord(completed, None, execution.startingTimeMs + 200000L, fromLog = true))
      (one.measured.asScala ++ other.measured.asScala).count(_ == execution.eid) shouldBe 1
      lines.count(_._2.startsWith(s"Execution ${execution.eid} of workflow")) shouldBe 1
    }
  }

  it should "never be revised when no unit started the execution: never started, or not compiled" in {
    val fixture = new Fixture()
    val neverStarted = created()
    fixture.clock.set(neverStarted.startingTimeMs + 600000L)
    fixture.tick()
    val notCompiledAtCreate = notCompiled()
    val verdicts = Seq(neverStarted, notCompiledAtCreate).map(closingOf)
    verdicts.map(_.map(_.reason.get.take(13))) shouldBe
      Seq(Some("never started"), Some("compile error"))
    verdicts.foreach(_.map(_.fromLog) shouldBe Some(false))

    // Whatever a log at their locations says.
    Seq(neverStarted, notCompiledAtCreate).foreach { execution =>
      withLog(execution)
      append(execution, "COMPLETED", 9000L)
    }
    fixture.labelsRead.clear()
    fixture.tick(3)

    Seq(neverStarted, notCompiledAtCreate).map(closingOf) shouldBe verdicts
    fixture.labelsRead.asScala shouldBe empty
    // Nor on request.
    fixture.closer.reviseIfEnded(record(neverStarted.eid)) shouldBe false
    fixture.closer.reviseIfEnded(record(notCompiledAtCreate.eid)) shouldBe false
    Seq(neverStarted, notCompiledAtCreate).map(closingOf) shouldBe verdicts
  }

  it should "stand while its warehouse cannot be reached, unread, and give way when it can be" in {
    val disabled = new Fixture()
    val execution = withLog(inserted(warehouse = Some(whid)))
    append(execution, "COMPLETED", 9000L)
    disabled.tick(3)
    val verdict = closingOf(execution)
    verdict.map(_.reason) shouldBe Some(Some("its warehouse is no longer available"))
    disabled.labelsRead.asScala shouldBe empty

    // Warehouses are switched on again within the hour.
    val enabled = new Fixture(settings.copy(warehousesEnabled = true), keepVerdicts = true)
    enabled.tick()

    closingOf(execution) shouldBe
      Some(ClosingRecord(completed, None, execution.startingTimeMs + 9000L, fromLog = true))
  }

  // --- the schedule ---

  "ExecutionClosingJob, once started," should "tick on its own until it is stopped" in {
    settle()
    val job = new ExecutionClosingJob(settings.copy(intervalSeconds = 1))
    val first = running()
    append(first, "COMPLETED", 9000L)

    job.start()
    try eventually { closingOf(first).map(_.outcome) shouldBe Some(completed) } finally job.stop()

    val second = running()
    append(second, "COMPLETED", 9000L)
    Thread.sleep(2500L)
    closingOf(second) shouldBe None
  }

  it should "stop without having been started" in {
    noException should be thrownBy new ExecutionClosingJob(settings).stop()
  }
}
