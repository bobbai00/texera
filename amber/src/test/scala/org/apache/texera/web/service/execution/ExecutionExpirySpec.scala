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
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  DocumentFactory,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  ExecutionPlanStore,
  ExecutionTables,
  PlanRecord,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore,
  VFSURIFactory
}
import org.apache.texera.amber.core.storedplan.{
  StoredOutputPort,
  StoredPhysicalOp,
  StoredPhysicalPlan
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PhysicalPlanCodec, PortIdentity}
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.{
  UserWarehouseFlavorEnum,
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
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.net.URI
import java.nio.file.{Files, Path}
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.{AtomicInteger, AtomicLong}
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Specs for [[ExecutionExpiry]], on real rows and real tables: the rows are in `MockTexeraDB`,
  * and each execution's plan, log, statistics, console, result and state tables are tables of
  * the catalog the build's tests use (the Postgres JDBC catalog in CI), named after this
  * suite's own workflows and executions and dropped after it.
  *
  * No large binary is deleted: the expiry under test notes the executions it would delete them
  * for. Replay logs are folders under a temporary directory.
  */
class ExecutionExpirySpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val testUid = 9871
  private val testWid = 9872
  private val otherWid = 9873
  private val warehouseName = s"user-$testUid-7"
  private var whid: Integer = _

  // Explicit ids, so every table's name is this suite's own.
  private val nextEid = new AtomicInteger(987100)
  private val madeEids = new ConcurrentLinkedQueue[Int]()
  private val nextCuid = new AtomicInteger(9880)

  private val endedAtMs = 1794873600000L
  private val expiredAtMs = endedAtMs + 3600000L

  private val storedPort = port("scan", 0)
  private val unstoredPort = port("search", 0)

  private val completed = WorkflowExecutionStatus.Completed
  private val failed = WorkflowExecutionStatus.Failed

  private var replayLogRoot: Path = _

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()

    val user = new User
    user.setUid(testUid)
    user.setName("execution-expiry-spec-user")
    user.setEmail(s"execution-expiry-${UUID.randomUUID()}@example.com")
    new UserDao(cfg).insert(user)

    Seq(testWid, otherWid).foreach { wid =>
      val workflow = new Workflow
      workflow.setWid(wid)
      workflow.setName(s"execution-expiry-spec-$wid")
      workflow.setContent("{}")
      workflow.setCreationTime(new Timestamp(endedAtMs))
      workflow.setLastModifiedTime(new Timestamp(endedAtMs))
      new WorkflowDao(cfg).insert(workflow)
      val version = new WorkflowVersion
      version.setWid(wid)
      version.setContent("{}")
      version.setCreationTime(new Timestamp(endedAtMs))
      new WorkflowVersionDao(cfg).insert(version)
    }

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUid)
    warehouse.setName("execution-expiry-warehouse")
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid

    replayLogRoot = Files.createTempDirectory("execution-expiry-spec")
  }

  override protected def afterAll(): Unit =
    try {
      // Whatever a case left, by the names of this suite's executions.
      madeEids.asScala.foreach { eid =>
        Seq(testWid, otherWid).foreach { wid =>
          Try(
            ExecutionTables.dropNamed(
              WorkflowIdentity(wid.toLong),
              ExecutionIdentity(eid.toLong),
              None,
              ExecutionTables.AllKinds
            )
          )
        }
      }
    } finally {
      closeConnectionPool()
      super.afterAll()
    }

  // --- rows ---

  private def freshUnit(): Int = {
    val cuid = nextCuid.getAndIncrement()
    val unit = new WorkflowComputingUnit
    unit.setCuid(cuid)
    unit.setUid(testUid)
    unit.setName(s"execution-expiry-unit-$cuid")
    unit.setCreationTime(new Timestamp(endedAtMs))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    new WorkflowComputingUnitDao(getDSLContext.configuration()).insert(unit)
    cuid
  }

  /** A unit of its own for a case that names none. */
  private lazy val someUnit = freshUnit()

  /**
    * An execution of `wid` on `cuid`: open, unless `outcome` closes it, as of `endedAtMs`.
    *
    * @param fromLog whether the outcome is its log's ending, not a verdict
    */
  private def made(
      outcome: Option[Short] = Some(completed),
      cuid: Int = someUnit,
      wid: Int = testWid,
      fromLog: Boolean = true,
      endedAt: Long = endedAtMs,
      warehouse: Option[Integer] = None,
      replayLog: Option[String] = None,
      eid: Int = nextEid.getAndIncrement()
  ): ExecutionRecord = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .fetchOneInto(classOf[Integer])
    madeEids.add(eid)
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(testUid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(cuid))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, new Timestamp(endedAt - 60000L))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.WHID, warehouse.orNull)
      .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, replayLog.orNull)
      .execute()
    outcome.foreach { how =>
      ExecutionRecords.close(eid.toLong, how, None, endedAt, fromLog) shouldBe true
    }
    record(eid.toLong)
  }

  private def record(eid: Long): ExecutionRecord =
    ExecutionRecords.find(eid).getOrElse(fail(s"execution $eid has no row"))

  private def row(execution: ExecutionRecord): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration())
      .fetchOneByEid(Integer.valueOf(execution.eid.toInt))

  // --- what an execution keeps in the lake ---

  private def port(operator: String, number: Int): GlobalPortIdentity =
    GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity(operator), "main"), PortIdentity(number))

  private def portBase(execution: ExecutionRecord, port: GlobalPortIdentity): URI =
    VFSURIFactory.createPortBaseURI(
      execution.workflowId,
      execution.executionId,
      port,
      execution.warehouse
    )

  private def resultOf(execution: ExecutionRecord, port: GlobalPortIdentity = storedPort): URI =
    VFSURIFactory.resultURI(portBase(execution, port))

  private def stateOf(execution: ExecutionRecord, port: GlobalPortIdentity = storedPort): URI =
    VFSURIFactory.stateURI(portBase(execution, port))

  private def consoleOf(execution: ExecutionRecord): URI =
    ConsoleMessageStore.consoleUri(execution.workflowId, execution.executionId, execution.warehouse)

  private def statisticsOf(execution: ExecutionRecord): URI =
    RuntimeStatisticsStore
      .statisticsUri(execution.workflowId, execution.executionId, execution.warehouse)

  /** A table of `execution` at a location no function of today's names. */
  private def oddTableOf(execution: ExecutionRecord, rest: String): URI =
    new URI(s"vfs:///wid/${execution.wid}/eid/${execution.eid}/$rest")

  /** Makes a table of lines at `uri`, as a run's writers do, with `rows` rows in it. */
  private def tableOfLines(uri: URI, rows: Int = 3): URI = {
    val schema = Schema().add("line", AttributeType.STRING)
    val document =
      DocumentFactory.createDocument(uri, schema).asInstanceOf[VirtualDocument[Tuple]]
    val writer = document.writer(UUID.randomUUID().toString)
    writer.open()
    (1 to rows).foreach(line => writer.putOne(Tuple(schema, Array[Any](s"line $line"))))
    writer.close()
    uri
  }

  /** Stores the plan of `execution`, which names where each of `ports` is stored. */
  private def withPlan(
      execution: ExecutionRecord,
      ports: Seq[GlobalPortIdentity] = Seq(storedPort, unstoredPort)
  ): ExecutionRecord = {
    val body = PhysicalPlanCodec.toJson(
      StoredPhysicalPlan(
        formatVersion = PhysicalPlanCodec.FormatVersion,
        operators = ports.map(port =>
          StoredPhysicalOp(outputPorts =
            Seq(StoredOutputPort(storageLocation = portBase(execution, port).toString))
          )
        )
      )
    )
    ExecutionPlanStore.writePlan(
      execution.planUri,
      PlanRecord(ExecutionPlanStore.PlanEntryId, body, testUid, execution.cuid.get),
      """{"operators":[],"links":[],"opsToViewResult":[],"opsToReuseResult":[]}"""
    )
    execution
  }

  /** Makes the log of `execution` and records `states` in it, a second apart. */
  private def withLog(execution: ExecutionRecord, states: String*): ExecutionRecord = {
    ExecutionLogStore.create(execution.logUri, execution.startingTimeMs + 1000L, 30000L)
    states.zipWithIndex.foreach {
      case (state, index) =>
        val atMs = execution.startingTimeMs + 2000L + index * 1000L
        ExecutionLogStore.append(
          execution.logUri,
          Seq(ExecutionLogEntry.state(index + 1L, atMs, state)),
          atMs
        )
    }
    execution
  }

  /**
    * Gives `execution` what a run leaves: its plan, its log, its statistics, its console, and
    * the result and the state of the one port the run stored.
    */
  private def ran(execution: ExecutionRecord): ExecutionRecord = {
    withPlan(execution)
    withLog(execution, "READY", "RUNNING", "COMPLETED")
    RuntimeStatisticsStore.create(statisticsOf(execution))
    RuntimeStatisticsStore.append(
      statisticsOf(execution),
      Seq(RuntimeStatisticsRow("scan", endedAtMs, 1, 2, 3, 4, 5, 6, 7, 1, 1))
    )
    ConsoleMessageStore.create(consoleOf(execution))
    ConsoleMessageStore.append(
      consoleOf(execution),
      Seq(ConsoleRow(1L, endedAtMs, "scan", "worker-0", "PRINT", "udf.py", "hello", "hello"))
    )
    tableOfLines(resultOf(execution))
    tableOfLines(stateOf(execution))
    execution
  }

  /**
    * Gives `execution` what one made before plans and logs were stored left: the result and the
    * state of a port, a console table for each of two operators, and a statistics table of
    * another shape under the name statistics have.
    *
    * @return its tables
    */
  private def ranBeforePlans(execution: ExecutionRecord): Seq[URI] =
    Seq(
      resultOf(execution),
      stateOf(execution),
      oddTableOf(execution, "opid/scan/consolemessages"),
      oddTableOf(execution, "opid/search/consolemessages"),
      statisticsOf(execution)
    ).map(tableOfLines(_))

  private def has(uri: URI): Boolean = ExecutionTables.exists(uri)

  private def producedBy(execution: ExecutionRecord): Seq[URI] =
    Seq(resultOf(execution), stateOf(execution), consoleOf(execution))

  private def keptBy(execution: ExecutionRecord): Seq[URI] =
    Seq(execution.planUri, execution.logUri, statisticsOf(execution))

  private def bytesOf(uris: Seq[URI]): Long = uris.map(ExecutionTables.storedBytes).sum

  /** A replay log of two files, where an execution's row says it keeps one. */
  private def replayLog(): Path = {
    val folder = Files.createDirectory(replayLogRoot.resolve(UUID.randomUUID().toString))
    Seq("coordinator", "worker-0").foreach(file =>
      Files.write(folder.resolve(file), Array[Byte](1))
    )
    folder
  }

  // --- the expiry ---

  /**
    * An expiry under test. It deletes no large binary: `binaries` notes the executions it would
    * delete them for, after `beforeBinaries` ran. Its lake calls are the stores', its clock
    * stands at `expiredAtMs`, and it deletes replay logs for real unless a case says otherwise.
    */
  private class Fixture(
      warehousesEnabled: Boolean = false,
      label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
      beforeBinaries: Long => Unit = _ => (),
      deleteReplayLog: String => Unit = ExecutionExpiry.deleteReplayLog,
      batchSize: Int = ExecutionExpiry.BatchSize
  ) {
    val binaries = new ConcurrentLinkedQueue[Long]()
    val labelsRead = new ConcurrentLinkedQueue[URI]()
    val clock = new AtomicLong(expiredAtMs)

    val expiry = new ExecutionExpiry(
      warehousesEnabled = warehousesEnabled,
      label = uri => {
        labelsRead.add(uri)
        label(uri)
      },
      deleteBinaries = eid => {
        beforeBinaries(eid)
        binaries.add(eid)
      },
      deleteReplayLog = deleteReplayLog,
      now = () => clock.get(),
      batchSize = batchSize
    )

    def binariesDeleted: Seq[Long] = binaries.asScala.toSeq
  }

  private class Outage extends RuntimeException("the lake is out of reach")

  /** Runs `body`, and answers the level and the message of every line the expiry logged. */
  private def logged(body: => Unit): Seq[(Level, String)] = {
    val logger = LoggerFactory.getLogger(classOf[ExecutionExpiry]).asInstanceOf[LogbackLogger]
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

  // --- expire ---

  "ExecutionExpiry.expire" should "drop what the run produced, keep its plan, log and statistics, and mark the row" in {
    val fixture = new Fixture()
    val execution = ran(made())
    ExecutionRecords.setStoredBytes(execution.eid, ExecutionCloser.storedBytesOf(execution))
    val before = row(execution).getStoredBytes.longValue()
    before shouldBe bytesOf(keptBy(execution) ++ producedBy(execution))

    val lines = logged { fixture.expiry.expire(execution.eid) shouldBe true }

    producedBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
    fixture.binariesDeleted shouldBe Seq(execution.eid)
    // What is kept can still be read.
    ExecutionLogStore.label(execution.logUri).flatMap(_.state) shouldBe Some("COMPLETED")
    RuntimeStatisticsStore.read(statisticsOf(execution)) should have size 1
    ExecutionPlanStore.readPlan(execution.planUri).createdBy shouldBe testUid

    val after = row(execution)
    after.getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    after.getStoredBytes.longValue() shouldBe bytesOf(keptBy(execution))
    after.getStoredBytes.longValue() should (be > 0L and be < before)
    // How it ended is as it was.
    record(execution.eid).closing shouldBe execution.closing
    lines shouldBe Seq(
      (
        Level.INFO,
        s"The results of execution ${execution.eid} of workflow $testWid are expired; its " +
          s"plan, log and statistics hold ${after.getStoredBytes} bytes."
      )
    )
  }

  it should "change nothing the second time" in {
    val fixture = new Fixture()
    val execution = ran(made())
    fixture.expiry.expire(execution.eid) shouldBe true
    val first = row(execution)
    fixture.clock.addAndGet(60000L)

    val lines = logged { fixture.expiry.expire(execution.eid) shouldBe false }

    row(execution) shouldBe first
    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
    fixture.binariesDeleted shouldBe Seq(execution.eid)
    lines shouldBe Nil
  }

  it should "leave another execution of the workflow untouched" in {
    val fixture = new Fixture()
    val expired = ran(made())
    val other = ran(made())

    fixture.expiry.expire(expired.eid) shouldBe true

    (producedBy(other) ++ keptBy(other)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe true }
    }
    row(other).getResultsExpiredAt shouldBe null
  }

  it should "leave an open execution, and one with no row, as they are" in {
    val fixture = new Fixture()
    val open = ran(made(outcome = None))

    fixture.expiry.expire(open.eid) shouldBe false
    fixture.expiry.expire(986999L) shouldBe false

    (producedBy(open) ++ keptBy(open)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe true }
    }
    row(open).getResultsExpiredAt shouldBe null
    fixture.binariesDeleted shouldBe Nil
  }

  it should "drop a table of a port the plan names that the run stored, and pass over one it did not" in {
    val fixture = new Fixture()
    val execution = ran(made())
    has(resultOf(execution, unstoredPort)) shouldBe false
    // A second stored port, and a table of the execution's that its plan does not name.
    val second = port("join", 1)
    withPlan(execution, Seq(storedPort, unstoredPort, second))
    val (secondResult, secondState) =
      (tableOfLines(resultOf(execution, second)), tableOfLines(stateOf(execution, second)))
    val unnamed = tableOfLines(resultOf(execution, port("left-behind", 0)))

    fixture.expiry.expire(execution.eid) shouldBe true

    (producedBy(execution) ++ Seq(secondResult, secondState)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe false }
    }
    // Found by the plan, not by a search: what the plan does not name is left for a delete.
    has(unnamed) shouldBe true
  }

  it should "find the tables of an execution with no plan by their names, and leave those of an execution whose id starts with its id" in {
    val fixture = new Fixture()
    // Two executions whose table names start alike, up to the end of the first one's id.
    val short = made()
    val long = made(eid = short.eid.toInt * 10 + 4)
    val shortTables = ranBeforePlans(short)
    val longTables = ranBeforePlans(long)

    fixture.expiry.expire(short.eid) shouldBe true

    // Its results, their states and its consoles go; the statistics stay.
    shortTables.init.foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    has(statisticsOf(short)) shouldBe true
    longTables.foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
    val after = row(short)
    after.getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    after.getStoredBytes.longValue() shouldBe ExecutionTables.storedBytes(statisticsOf(short))
    row(long).getResultsExpiredAt shouldBe null
  }

  it should "find the tables by their names when the stored plan does not tell where the ports are, and say so" in {
    val fixture = new Fixture()
    val execution = ran(made())
    ExecutionPlanStore.drop(execution.planUri)
    ExecutionPlanStore.writePlan(
      execution.planUri,
      PlanRecord(ExecutionPlanStore.PlanEntryId, """{"formatVersion":2}""", testUid, 1),
      "{}"
    )

    val lines = logged { fixture.expiry.expire(execution.eid) shouldBe true }

    producedBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
    val warnings = lines.collect { case (Level.WARN, line) => line }
    warnings should have size 1
    warnings.head should startWith(
      s"The stored plan of execution ${execution.eid} does not tell where its ports are " +
        "stored, so its tables are found by their names: "
    )
  }

  it should "expire an execution that left nothing: no table, and no bytes" in {
    val fixture = new Fixture()
    val execution = made(outcome = Some(failed), fromLog = false)

    fixture.expiry.expire(execution.eid) shouldBe true

    row(execution).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    row(execution).getStoredBytes shouldBe 0L
  }

  it should "leave the tables of an execution in a per-user warehouse alone while those are disabled, and not mark it" in {
    // Under any catalog but the REST one, a warehouse's URI names the same table as the default's.
    val execution = ran(made(warehouse = Some(whid)))
    execution.planUri.toString should include(s"/wh/$warehouseName/")
    val disabled = new Fixture(warehousesEnabled = false)

    val lines = logged { disabled.expiry.expire(execution.eid) shouldBe false }

    (producedBy(execution) ++ keptBy(execution)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe true }
    }
    row(execution).getResultsExpiredAt shouldBe null
    disabled.binariesDeleted shouldBe Nil
    lines shouldBe Seq(
      (
        Level.INFO,
        s"Leaving the results of execution ${execution.eid} where they are: per-user " +
          "warehouses are disabled."
      )
    )

    // With warehouses enabled it is expired like any other, in its warehouse.
    new Fixture(warehousesEnabled = true).expiry.expire(execution.eid) shouldBe true
    producedBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
  }

  it should "leave the row unmarked when something fails, so that a later call finishes" in {
    val outage = new Outage
    val failing = new Fixture(beforeBinaries = _ => throw outage)
    val execution = ran(made())

    the[Outage] thrownBy failing.expiry.expire(execution.eid) shouldBe outage

    row(execution).getResultsExpiredAt shouldBe null
    ExecutionRecords.unexpired(execution.eid) shouldBe defined

    val fixture = new Fixture()
    fixture.expiry.expire(execution.eid) shouldBe true
    fixture.binariesDeleted shouldBe Seq(execution.eid)
    row(execution).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  it should "let one of two that expire the same execution at once mark it" in {
    val execution = ran(made())
    val fixtures = Seq(new Fixture(), new Fixture())
    val marked = new ConcurrentLinkedQueue[Try[Boolean]]()

    val threads = fixtures.map { fixture =>
      new Thread(() => marked.add(Try(fixture.expiry.expire(execution.eid))))
    }
    threads.foreach(_.start())
    threads.foreach(_.join(60000L))

    marked.asScala.toSeq.map(_.get).sorted shouldBe Seq(false, true)
    producedBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe true })
  }

  // --- the replay log ---

  it should "leave the replay log where it is, unless told to delete it" in {
    val fixture = new Fixture()
    val folder = replayLog()
    val execution = ran(made(replayLog = Some(folder.toUri.toString)))

    fixture.expiry.expire(execution.eid) shouldBe true

    Files.list(folder).count() shouldBe 2L
    row(execution).getLogLocation shouldBe folder.toUri.toString
  }

  it should "delete the replay log with every file in it, and stop naming it, when told to" in {
    val fixture = new Fixture()
    val folder = replayLog()
    val execution = ran(made(replayLog = Some(folder.toUri.toString)))

    fixture.expiry.expire(execution.eid, withReplayLog = true) shouldBe true

    Files.exists(folder) shouldBe false
    row(execution).getLogLocation shouldBe null
    row(execution).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  it should "log a replay log that cannot be deleted, keep naming it, and expire the results all the same" in {
    val outage = new Outage
    val fixture = new Fixture(deleteReplayLog = _ => throw outage)
    val execution = ran(made(replayLog = Some("file:///replay/of/an/execution/")))

    val lines = logged { fixture.expiry.expire(execution.eid, withReplayLog = true) shouldBe true }

    row(execution).getLogLocation shouldBe "file:///replay/of/an/execution/"
    row(execution).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    producedBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
    lines.collect { case (Level.WARN, line) => line } shouldBe Seq(
      s"The replay log of execution ${execution.eid} at file:///replay/of/an/execution/ could " +
        "not be deleted, so it is left."
    )
  }

  it should "leave a location that names no storage as one that cannot be deleted" in {
    val fixture = new Fixture()
    // No scheme, and no URI at all.
    Seq("no-scheme/logs", "has space/logs").foreach { location =>
      val execution = made(replayLog = Some(location))

      withClue(s"'$location': ") {
        fixture.expiry.expire(execution.eid, withReplayLog = true) shouldBe true
        row(execution).getLogLocation shouldBe location
      }
    }
  }

  it should "ask for no replay log to be deleted for an execution that names none" in {
    val asked = new ConcurrentLinkedQueue[String]()
    val fixture = new Fixture(deleteReplayLog = location => asked.add(location))
    val none = made()
    val blank = made(replayLog = Some(""))

    fixture.expiry.expire(none.eid, withReplayLog = true) shouldBe true
    fixture.expiry.expire(blank.eid, withReplayLog = true) shouldBe true

    asked.asScala shouldBe empty
  }

  // --- expirePast ---

  /**
    * A time so many days before the other cases' executions ended. A pass by age looks at every
    * execution, so each of its cases looks further back than what the cases before it left.
    */
  private def daysBefore(days: Int): Long = endedAtMs - days * 86400000L

  /** The age of what ended by `ms`, when no verdict that old is replaced any more. */
  private def endedBy(ms: Long): PastAge = PastAge(ms, verdictsBeforeMs = ms + 1L)

  "ExecutionExpiry.expirePast" should "expire what ended by the time given, with its replay log, and nothing younger" in {
    val fixture = new Fixture()
    val byMs = daysBefore(10)
    val folder = replayLog()
    val youngFolder = replayLog()
    val old = ran(made(endedAt = byMs - 1000L, replayLog = Some(folder.toUri.toString)))
    val onTime = ran(made(endedAt = byMs))
    val young = ran(made(endedAt = byMs + 1L, replayLog = Some(youngFolder.toUri.toString)))
    val open = ran(made(outcome = None))

    val lines = logged { fixture.expiry.expirePast(endedBy(byMs)) shouldBe 2 }

    Seq(old, onTime).foreach { expired =>
      withClue(s"execution ${expired.eid}: ") {
        producedBy(expired).foreach(has(_) shouldBe false)
        keptBy(expired).foreach(has(_) shouldBe true)
        row(expired).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
      }
    }
    Files.exists(folder) shouldBe false
    row(old).getLogLocation shouldBe null
    Seq(young, open).foreach { left =>
      withClue(s"execution ${left.eid}: ") {
        producedBy(left).foreach(has(_) shouldBe true)
        row(left).getResultsExpiredAt shouldBe null
      }
    }
    Files.list(youngFolder).count() shouldBe 2L
    row(young).getLogLocation shouldBe youngFolder.toUri.toString
    lines.map(_._2) shouldBe Seq(old, onTime).map { expired =>
      s"The results of execution ${expired.eid} of workflow $testWid are expired by age; its " +
        s"plan, log and statistics hold ${row(expired).getStoredBytes} bytes."
    }

    // Once more there is nothing left that old.
    fixture.expiry.expirePast(endedBy(byMs)) shouldBe 0
  }

  it should "go through every execution that old, a batch at a time, past one that cannot be expired" in {
    val outage = new Outage
    val longAgoMs = daysBefore(20)
    val executions = (1 to 5).map(_ => ran(made(endedAt = longAgoMs)))
    val stuck = executions(1)
    val failing = new Fixture(
      beforeBinaries = eid => if (eid == stuck.eid) throw outage,
      batchSize = 2
    )

    val lines = logged { failing.expiry.expirePast(endedBy(longAgoMs)) shouldBe 4 }

    executions.filterNot(_ == stuck).foreach { expired =>
      withClue(s"execution ${expired.eid}: ") {
        row(expired).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
      }
    }
    row(stuck).getResultsExpiredAt shouldBe null
    lines.collect { case (Level.WARN, line) => line } shouldBe Seq(
      s"The results of execution ${stuck.eid} could not be expired, so it keeps them."
    )

    // A later pass finds it again.
    new Fixture(batchSize = 2).expiry.expirePast(endedBy(longAgoMs)) shouldBe 1
    row(stuck).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  it should "never look for the tables of an execution that no unit ever started" in {
    val fixture = new Fixture()
    val longAgoMs = daysBefore(30)
    val neverStarted = made(outcome = None)
    ExecutionRecords.close(
      neverStarted.eid,
      failed,
      Some(ExecutionClosing.NeverStarted),
      longAgoMs,
      fromLog = false,
      neverStarted = true
    ) shouldBe true
    // A table at a name of its, which the expiry would drop if it looked.
    val console =
      ConsoleMessageStore.consoleUri(neverStarted.workflowId, neverStarted.executionId, None)
    ConsoleMessageStore.create(console)

    fixture.expiry.expirePast(endedBy(longAgoMs)) shouldBe 0

    has(console) shouldBe true
    row(neverStarted).getResultsExpiredAt shouldBe new Timestamp(longAgoMs)
    fixture.binariesDeleted shouldBe Nil
  }

  it should "pass over an execution in a per-user warehouse while those are disabled" in {
    val fixture = new Fixture()
    val longAgoMs = daysBefore(40)
    val execution = made(endedAt = longAgoMs, warehouse = Some(whid))

    logged { fixture.expiry.expirePast(endedBy(longAgoMs)) shouldBe 0 } shouldBe Nil

    row(execution).getResultsExpiredAt shouldBe null
    new Fixture(warehousesEnabled = true).expiry.expirePast(endedBy(longAgoMs)) shouldBe 1
  }

  it should "not mark an execution by an age it no longer has, when its log's ending took its verdict's place meanwhile" in {
    val byMs = daysBefore(50)
    val verdict = ran(
      made(
        outcome = Some(failed),
        fromLog = false,
        endedAt = byMs,
        replayLog = Some("file:///replay/of/a/verdict/")
      )
    )
    // Its unit was back: the closing job records the ending its log shows, later than the
    // verdict, while the expiry is at work on the execution.
    val fixture = new Fixture(deleteReplayLog = _ => {
      ExecutionRecords.revise(verdict.eid, completed, None, byMs + 5000L) shouldBe true
    })

    fixture.expiry.expirePast(endedBy(byMs)) shouldBe 0

    row(verdict).getResultsExpiredAt shouldBe null
    record(verdict.eid).closing shouldBe
      Some(ClosingRecord(completed, None, byMs + 5000L, fromLog = true))
    // The replay log it deleted is no longer named, whoever marks the row.
    row(verdict).getLogLocation shouldBe null

    // A pass that finds it that old marks it.
    fixture.expiry.expirePast(endedBy(byMs + 5000L)) shouldBe 1
    row(verdict).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  it should "keep the results of an execution closed by a verdict for as long as its log's ending may replace it" in {
    val fixture = new Fixture()
    val byMs = daysBefore(60)
    val verdict = ran(made(outcome = Some(failed), fromLog = false, endedAt = byMs))
    val fromLog = ran(made(endedAt = byMs))

    // Both are older than results are kept, and a verdict that old is still replaced.
    fixture.expiry.expirePast(PastAge(byMs, verdictsBeforeMs = byMs)) shouldBe 1

    producedBy(verdict).foreach(has(_) shouldBe true)
    row(verdict).getResultsExpiredAt shouldBe null
    row(fromLog).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)

    // Once it is not, its results go as any other's.
    fixture.expiry.expirePast(PastAge(byMs, verdictsBeforeMs = byMs + 1L)) shouldBe 1
    producedBy(verdict).foreach(has(_) shouldBe false)
    row(verdict).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  // --- expireReplaced ---

  "ExecutionExpiry.expireReplaced" should "expire the closed executions of the workflow on the unit made before one a unit has started, and only those" in {
    val fixture = new Fixture()
    val (unit, otherUnit) = (freshUnit(), freshUnit())
    val folder = replayLog()
    // Closed, on the unit, holding results: completed, failed by a verdict, and with a replay log.
    val first = ran(made(cuid = unit))
    val second = ran(made(outcome = Some(failed), cuid = unit, fromLog = false))
    val third = ran(made(cuid = unit, replayLog = Some(folder.toUri.toString)))
    // Expired already.
    val expired = ran(made(cuid = unit))
    fixture.expiry.expire(expired.eid) shouldBe true
    // Open: it may still run.
    val open = ran(made(outcome = None, cuid = unit))
    // Another unit's and another workflow's.
    val elsewhere = ran(made(cuid = otherUnit))
    val otherWorkflows = ran(made(cuid = unit, wid = otherWid))
    // What the unit runs now: started, and not ended.
    val running = withLog(withPlan(made(outcome = None, cuid = unit)), "READY", "RUNNING")
    // Made since, and started by no unit.
    val created = withPlan(made(outcome = None, cuid = unit))
    fixture.binaries.clear()

    val lines = logged {
      fixture.expiry.expireReplaced(testWid, unit, created.eid) shouldBe true
    }

    Seq(first, second, third).foreach { replaced =>
      withClue(s"execution ${replaced.eid}: ") {
        producedBy(replaced).foreach(has(_) shouldBe false)
        keptBy(replaced).foreach(has(_) shouldBe true)
        row(replaced).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
        row(replaced).getStoredBytes.longValue() shouldBe bytesOf(keptBy(replaced))
      }
    }
    fixture.binariesDeleted shouldBe Seq(first, second, third).map(_.eid)
    // Replaced, not past its age: its replay log stays, for a replay of it.
    Files.list(folder).count() shouldBe 2L
    row(third).getLogLocation shouldBe folder.toUri.toString
    Seq(open, elsewhere, otherWorkflows).foreach { left =>
      withClue(s"execution ${left.eid}: ") {
        producedBy(left).foreach(has(_) shouldBe true)
        row(left).getResultsExpiredAt shouldBe null
      }
    }
    row(expired).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    lines.map(_._2) shouldBe Seq(first, second, third).map { replaced =>
      s"The results of execution ${replaced.eid} of workflow $testWid are expired, which " +
        s"execution ${running.eid} replaced on computing unit $unit; its plan, log and " +
        s"statistics hold ${row(replaced).getStoredBytes} bytes."
    }
  }

  it should "keep what the unit ran last until it has started a later execution" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val shown = ran(made(cuid = unit))
    // Created and not started, failed at its create, and started with no state written yet.
    val abandoned = withPlan(made(outcome = None, cuid = unit))
    val notCompiled = made(outcome = None, cuid = unit)
    ExecutionRecords.close(
      notCompiled.eid,
      failed,
      Some("compile error: boom"),
      endedAtMs,
      fromLog = false,
      neverStarted = true
    ) shouldBe true
    val next = withPlan(made(outcome = None, cuid = unit))
    ExecutionPlanStore.claimStart(next.planUri)
    withLog(next)

    fixture.expiry.expireReplaced(testWid, unit, next.eid) shouldBe true

    producedBy(shown).foreach(has(_) shouldBe true)
    row(shown).getResultsExpiredAt shouldBe null
    fixture.binariesDeleted shouldBe Nil

    // The unit writes the run's first state.
    ExecutionLogStore.append(
      next.logUri,
      Seq(ExecutionLogEntry.state(1L, endedAtMs + 5000L, "READY")),
      endedAtMs + 5000L
    )

    fixture.expiry.expireReplaced(testWid, unit, next.eid) shouldBe true

    producedBy(shown).foreach(has(_) shouldBe false)
    row(shown).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    Seq(abandoned, next).foreach(left => row(left).getResultsExpiredAt shouldBe null)
  }

  it should "take an ending that its log gave an execution for a start, without reading its log again" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val first = ran(made(cuid = unit))
    // Ended in its log, and closed by it: what the unit ran last.
    val last = ran(made(cuid = unit))
    val created = withPlan(made(outcome = None, cuid = unit))

    fixture.expiry.expireReplaced(testWid, unit, created.eid) shouldBe true

    row(first).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    row(last).getResultsExpiredAt shouldBe null
    producedBy(last).foreach(has(_) shouldBe true)
    // Only the one that was created and may have been started since is read.
    fixture.labelsRead.asScala.toSeq shouldBe Seq(created.logUri)
  }

  it should "take a run that a verdict closed for a start, if its log names a state" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val first = ran(made(cuid = unit))
    // Its unit was lost under its run: closed by a verdict, with a log that names a state.
    val lost = withLog(
      withPlan(made(outcome = Some(failed), cuid = unit, fromLog = false)),
      "READY",
      "RUNNING"
    )
    // Closed by a verdict with no log: its unit was terminated before it started it.
    val unstarted = withPlan(made(outcome = Some(failed), cuid = unit, fromLog = false))

    fixture.expiry.expireReplaced(testWid, unit, unstarted.eid) shouldBe true

    row(first).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    row(lost).getResultsExpiredAt shouldBe null
    fixture.labelsRead.asScala.toSeq shouldBe Seq(unstarted.logUri, lost.logUri)
  }

  it should "replace nothing when no earlier execution holds results, reading no log" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val running = withLog(withPlan(made(outcome = None, cuid = unit)), "READY", "RUNNING")

    fixture.expiry.expireReplaced(testWid, unit, running.eid) shouldBe true

    fixture.labelsRead.asScala shouldBe empty
  }

  it should "keep every result, and say so, when a log cannot be read" in {
    val outage = new Outage
    val fixture = new Fixture(label = _ => throw outage)
    val unit = freshUnit()
    val first = ran(made(cuid = unit))
    val running = withLog(withPlan(made(outcome = None, cuid = unit)), "READY", "RUNNING")

    val lines = logged {
      fixture.expiry.expireReplaced(testWid, unit, running.eid) shouldBe false
    }

    row(first).getResultsExpiredAt shouldBe null
    producedBy(first).foreach(has(_) shouldBe true)
    lines shouldBe Seq(
      (
        Level.WARN,
        s"What execution ${running.eid} of workflow $testWid replaced on computing unit $unit " +
          "could not be told, so the earlier executions keep their results."
      )
    )
  }

  it should "not read the log of an execution whose warehouse cannot be reached: it counts as not started" in {
    val fixture = new Fixture()
    val unit = freshUnit()
    val first = ran(made(cuid = unit))
    // In a per-user warehouse, while those are disabled.
    val unreachable =
      withLog(made(outcome = None, cuid = unit, warehouse = Some(whid)), "READY", "RUNNING")

    fixture.expiry.expireReplaced(testWid, unit, unreachable.eid) shouldBe true

    row(first).getResultsExpiredAt shouldBe null
    fixture.labelsRead.asScala shouldBe empty
  }

  it should "log an execution that cannot be expired, go on to the next, and answer that one failed" in {
    val outage = new Outage
    val unit = freshUnit()
    val stuck = ran(made(cuid = unit))
    val replaced = ran(made(cuid = unit))
    val running = withLog(withPlan(made(outcome = None, cuid = unit)), "READY", "RUNNING")
    val failing = new Fixture(beforeBinaries = eid => if (eid == stuck.eid) throw outage)

    val lines = logged {
      failing.expiry.expireReplaced(testWid, unit, running.eid) shouldBe false
    }

    row(stuck).getResultsExpiredAt shouldBe null
    row(replaced).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
    lines.collect { case (Level.WARN, line) => line } shouldBe Seq(
      s"The results of execution ${stuck.eid} could not be expired, so it keeps them."
    )

    new Fixture().expiry.expireReplaced(testWid, unit, running.eid) shouldBe true
    row(stuck).getResultsExpiredAt shouldBe new Timestamp(expiredAtMs)
  }

  // --- dropAll ---

  "ExecutionExpiry.dropAll" should "leave no table of the execution, no large binary and no replay log, and leave its row" in {
    val fixture = new Fixture()
    val folder = replayLog()
    val execution = ran(made(replayLog = Some(folder.toUri.toString)))
    val other = ran(made())
    // A table of the execution's that its plan does not name.
    val unnamed = tableOfLines(resultOf(execution, port("left-behind", 0)))
    val before = row(execution)

    val logLines = logged { fixture.expiry.dropAll(execution.eid) }

    (producedBy(execution) ++ keptBy(execution) :+ unnamed).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe false }
    }
    fixture.binariesDeleted shouldBe Seq(execution.eid)
    Files.exists(folder) shouldBe false
    // The row is the caller's to delete; it no longer names the replay log, which is gone.
    val after = row(execution)
    after.getLogLocation shouldBe null
    after.setLogLocation(before.getLogLocation)
    after shouldBe before
    (producedBy(other) ++ keptBy(other)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe true }
    }
    logLines shouldBe Seq(
      (
        Level.INFO,
        s"Dropped what execution ${execution.eid} of workflow $testWid kept: 7 tables."
      )
    )
  }

  it should "drop what an execution made before plans and logs were stored left, statistics included" in {
    val fixture = new Fixture()
    val execution = made()
    val tables = ranBeforePlans(execution)

    fixture.expiry.dropAll(execution.eid)

    tables.foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
  }

  it should "drop what an expired execution still keeps" in {
    val fixture = new Fixture()
    val execution = ran(made())
    fixture.expiry.expire(execution.eid) shouldBe true

    fixture.expiry.dropAll(execution.eid)

    keptBy(execution).foreach(uri => withClue(s"$uri: ") { has(uri) shouldBe false })
  }

  it should "drop the tables of an open execution as well" in {
    val fixture = new Fixture()
    val open = ran(made(outcome = None))

    fixture.expiry.dropAll(open.eid)

    (producedBy(open) ++ keptBy(open)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe false }
    }
  }

  it should "leave the tables of an execution in a per-user warehouse where they are while those are disabled" in {
    val fixture = new Fixture(warehousesEnabled = false)
    val folder = replayLog()
    val execution =
      ran(made(warehouse = Some(whid), replayLog = Some(folder.toUri.toString)))

    val logLines = logged { fixture.expiry.dropAll(execution.eid) }

    (producedBy(execution) ++ keptBy(execution)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe true }
    }
    // What it keeps outside its warehouse goes with it.
    fixture.binariesDeleted shouldBe Seq(execution.eid)
    Files.exists(folder) shouldBe false
    logLines.map(_._2) shouldBe Seq(
      s"Dropped what execution ${execution.eid} of workflow $testWid kept: its tables are " +
        "left where they are, as per-user warehouses are disabled."
    )

    new Fixture(warehousesEnabled = true).expiry.dropAll(execution.eid)
    (producedBy(execution) ++ keptBy(execution)).foreach { uri =>
      withClue(s"$uri: ") { has(uri) shouldBe false }
    }
  }

  it should "do nothing for an execution with no row" in {
    val fixture = new Fixture()

    logged { fixture.expiry.dropAll(986999L) } shouldBe Nil

    fixture.binariesDeleted shouldBe Nil
  }

  it should "throw what fails, for the caller to keep the row" in {
    val outage = new Outage
    val failing = new Fixture(beforeBinaries = _ => throw outage)
    val execution = ran(made())

    the[Outage] thrownBy failing.expiry.dropAll(execution.eid) shouldBe outage
  }

  "ExecutionExpiry.deleteReplayLog" should "delete the folder a location names, with its files" in {
    val folder = replayLog()

    ExecutionExpiry.deleteReplayLog(folder.toUri.toString)

    Files.exists(folder) shouldBe false
  }
}
