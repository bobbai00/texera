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
import org.apache.texera.amber.core.storage.model.BufferedItemWriter
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionPlan,
  PhysicalPlan,
  PhysicalPlanCodec,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.{MockTexeraDB, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.{UserRoleEnum, UserWarehouseFlavorEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{UserDao, WorkflowDao, WorkflowVersionDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{User, Workflow, WorkflowVersion}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}
import org.slf4j.LoggerFactory

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger, AtomicReference}
import java.util.concurrent.{CompletableFuture, CountDownLatch, TimeUnit}
import scala.collection.mutable
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * The cost hints a run is given: the costs in the statistics of its user's newest run of the
  * workflow that is closed as completed, read once per run from where the run's row says its
  * tables are.
  *
  * Runs are rows of `MockTexeraDB`; their statistics are tables of the Iceberg catalog the tests
  * run with (`STORAGE_ICEBERG_CATALOG_TYPE=postgres`), written as a run's record writes them
  * (`RuntimeStatisticsStore`). Each case has workflows of its own, with ids from 9521 to 9542
  * that no other suite uses, and a run's id is its workflow's id times 100 plus a number:
  * creating a statistics table replaces the one of the same workflow and run, and suites share
  * the catalog. The cases of loads at the same time (workflows 9537 to 9539) hold
  * a read of statistics at a gate until the other loads wait for it.
  */
class CostHintsLoaderSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with Eventually
    with MockTexeraDB {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(20, Millis))

  /** The user whose run is given the hints. */
  private val runUser = 9521

  /** Another user, who runs the same workflows. */
  private val otherUser = 9522

  /** Seconds are given to the second, as `starting_time` keeps them. */
  private val firstStart = Timestamp.valueOf("2026-01-01 00:00:00").getTime

  private val tables = mutable.ListBuffer.empty[URI]

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val users = new UserDao(getDSLContext.configuration())
    Seq(runUser, otherUser).foreach { uid =>
      val user = new User
      user.setUid(uid)
      user.setName(s"cost-hints-user-$uid")
      user.setEmail(s"cost-hints-$uid@example.com")
      user.setRole(UserRoleEnum.REGULAR)
      users.insert(user)
    }
  }

  override protected def afterAll(): Unit =
    try {
      tables.foreach(dropStatistics)
      closeConnectionPool()
    } finally super.afterAll()

  /** Adds workflow `wid` with one version. */
  private def newWorkflow(wid: Int): Unit = {
    val workflow = new Workflow
    workflow.setWid(wid)
    workflow.setName(s"cost-hints-workflow-$wid")
    workflow.setContent("{}")
    workflow.setDescription("")
    new WorkflowDao(getDSLContext.configuration()).insert(workflow)
    newVersion(wid)
  }

  /** Adds a version of workflow `wid`, as saving an edit of it does: runs added after are of it. */
  private def newVersion(wid: Int): Unit = {
    val version = new WorkflowVersion
    version.setWid(wid)
    version.setContent("{}")
    new WorkflowVersionDao(getDSLContext.configuration()).insert(version)
  }

  /**
    * Adds run `eid` of workflow `wid` by user `uid`, started `startedAt` seconds after the first
    * start. A run in a state that is an ending is closed with it; in any other state it is
    * open. Like a run the service starts, it is of the workflow's latest version.
    *
    * @param whid the warehouse the run writes into
    */
  private def run(
      eid: Int,
      wid: Int,
      uid: Int,
      state: WorkflowAggregatedState,
      startedAt: Int,
      whid: Option[Integer] = None
  ): Unit = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .orderBy(WORKFLOW_VERSION.VID.desc())
      .limit(1)
      .fetchOneInto(classOf[Integer])
    val code = maptoStatusCode(state).toShort
    val ended = WorkflowExecutionStatus.Ended.contains(code)
    val started = new Timestamp(firstStart + startedAt * 1000L)
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(uid))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, started)
      .set(WORKFLOW_EXECUTIONS.NAME, s"cost-hints-run-$eid")
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.WHID, whid.orNull)
      .set(WORKFLOW_EXECUTIONS.OUTCOME, if (ended) java.lang.Short.valueOf(code) else null)
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, if (ended) started else null)
      .execute()
  }

  private def statisticsUri(wid: Int, eid: Int): URI =
    RuntimeStatisticsStore.statisticsUri(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(eid.toLong),
      None
    )

  /**
    * Creates the statistics of run `eid` of workflow `wid`, a row for each of `rows`: an
    * operator's id, and the nanoseconds it spent processing data and control messages. Returns
    * where they are.
    */
  private def statistics(wid: Int, eid: Int, rows: (String, Long, Long)*): String = {
    val uri = statisticsUri(wid, eid)
    tables += uri
    RuntimeStatisticsStore.create(uri)
    RuntimeStatisticsStore.append(
      uri,
      rows.zipWithIndex.map {
        case ((operatorId, dataNanos, controlNanos), index) =>
          RuntimeStatisticsRow(
            operatorId,
            firstStart + index,
            10L,
            100L,
            10L,
            100L,
            dataNanos,
            controlNanos,
            7_000_000_000L,
            1,
            0
          )
      }
    )
    uri.toString
  }

  /**
    * Creates the statistics of run `eid` of workflow `wid` as Texera stored them before a run's
    * record did: the time of a row a timestamp, in a column of another name. One row, of
    * operator `scan`. Returns where they are.
    */
  private def statisticsOfAnEarlierVersion(wid: Int, eid: Int): String = {
    val earlierSchema = new Schema(
      new Attribute("operatorId", AttributeType.STRING),
      new Attribute("time", AttributeType.TIMESTAMP),
      new Attribute("inputTupleCnt", AttributeType.LONG),
      new Attribute("inputTupleSize", AttributeType.LONG),
      new Attribute("outputTupleCnt", AttributeType.LONG),
      new Attribute("outputTupleSize", AttributeType.LONG),
      new Attribute("dataProcessingTime", AttributeType.LONG),
      new Attribute("controlProcessingTime", AttributeType.LONG),
      new Attribute("idleTime", AttributeType.LONG),
      new Attribute("numWorkers", AttributeType.INTEGER),
      new Attribute("status", AttributeType.INTEGER)
    )
    val uri = statisticsUri(wid, eid)
    tables += uri
    val writer = DocumentFactory
      .createDocument(uri, earlierSchema)
      .writer("cost-hints-spec")
      .asInstanceOf[BufferedItemWriter[Tuple]]
    writer.open()
    writer.putOne(
      new Tuple(
        earlierSchema,
        Array("scan", new Timestamp(firstStart), 10L, 100L, 10L, 100L, 3_000_000_000L, 0L, 0L, 1, 3)
      )
    )
    writer.close()
    uri.toString
  }

  private def dropStatistics(uri: URI): Unit = Try(RuntimeStatisticsStore.drop(uri))

  /**
    * Adds workflow `wid` and its one run, `wid` times 100 plus 1, completed by the run's user,
    * whose statistics hold `rows`. Returns where they are.
    */
  private def onlyCompletedRun(wid: Int, rows: (String, Long, Long)*): String = {
    newWorkflow(wid)
    val eid = wid * 100 + 1
    val source = statistics(wid, eid, rows: _*)
    run(eid, wid, runUser, COMPLETED, 10)
    source
  }

  /** Cost hints of run `eid` giving each named operator its seconds. */
  private def hintsOf(eid: Int, seconds: (String, Double)*): Option[CostHints] =
    Some(CostHints(ExecutionIdentity(eid.toLong), seconds.toMap))

  /**
    * A loader that counts how often it opens the statistics at each location. A read fails
    * while `failing` is set, as one does that the lake does not answer.
    */
  private final class CountingLoader(
      cacheCapacity: Int = 256,
      val opened: mutable.Map[String, Int] = mutable.Map.empty[String, Int].withDefaultValue(0),
      val failing: AtomicBoolean = new AtomicBoolean(false)
  ) extends CostHintsLoader(
        cacheCapacity,
        openStatistics = uri => {
          opened(uri.toString) += 1
          if (failing.get()) throw new IllegalStateException("the lake does not answer")
          CostHintsLoader.statisticsAt(uri)
        }
      )

  /** What a [[GatedLoader]]'s reads of statistics wait at, and whether they then fail. */
  private final class Gate {
    val opened = new AtomicInteger()
    val reading = new CountDownLatch(1)
    val gate = new CountDownLatch(1)
    @volatile var failing = false

    def open(uri: URI): Seq[RuntimeStatisticsRow] = {
      opened.incrementAndGet()
      reading.countDown()
      gate.await(30, TimeUnit.SECONDS)
      if (failing) throw new IllegalStateException("the statistics cannot be read")
      CostHintsLoader.statisticsAt(uri)
    }
  }

  /**
    * A loader whose reads of statistics, once begun, wait at `gate`, so that other loads can be
    * made to miss the same run while one reads it. A read fails while `failing` is set.
    */
  private final class GatedLoader(waitLimit: FiniteDuration = 30.seconds, at: Gate = new Gate)
      extends CostHintsLoader(256, waitLimit, at.open) {
    def opened: AtomicInteger = at.opened
    def reading: CountDownLatch = at.reading
    def gate: CountDownLatch = at.gate
    def failing_=(fail: Boolean): Unit = at.failing = fail
    def failing: Boolean = at.failing
  }

  /** A load of workflow `wid`'s hints by the run's user, on a thread of its own. */
  private final class LoadingThread(loader: CostHintsLoader, wid: Int) extends Thread {
    val hints = new AtomicReference[Option[CostHints]]()
    override def run(): Unit = hints.set(loader.load(wid, runUser))
    start()
  }

  /**
    * Whether `thread` is parked on the outcome of a read another load makes. A load that read on
    * its own would be parked at the gate instead, and one still asking the database is running.
    */
  private def waitsForAnotherRead(thread: Thread): Boolean =
    thread.getState == Thread.State.TIMED_WAITING &&
      thread.getStackTrace.exists(frame =>
        frame.getClassName == classOf[CompletableFuture[_]].getName && frame.getMethodName == "get"
      )

  /**
    * Starts a load of workflow `wid` that reads its statistics and holds at `loader`'s gate, then
    * `others` loads that miss the same run, and opens the gate once every other load waits for
    * that read. Returns every load, the reading one first, all ended.
    */
  private def overlappingLoads(loader: GatedLoader, wid: Int, others: Int): Seq[LoadingThread] = {
    val reader = new LoadingThread(loader, wid)
    loader.reading.await(30, TimeUnit.SECONDS) shouldBe true
    val waiters = Seq.fill(others)(new LoadingThread(loader, wid))
    eventually { waiters.forall(waitsForAnotherRead) shouldBe true }
    loader.gate.countDown()
    val loads = reader +: waiters
    loads.foreach(_.join(30000))
    loads.map(_.isAlive).distinct shouldBe Seq(false)
    loads
  }

  /** The events `loader` logs during `body`, at debug level and above. */
  private def loggedBy(loader: CostHintsLoader)(body: => Any): Seq[ILoggingEvent] = {
    // LazyLogging names a loader's logger after the loader's class.
    val logger = LoggerFactory.getLogger(loader.getClass.getName).asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val (previousLevel, previousAdditive) = (logger.getLevel, logger.isAdditive)
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.DEBUG)
    // Kept off the shared console, which would print the stack trace.
    logger.setAdditive(false)
    try {
      body
      appender.list.asScala.toList
    } finally {
      logger.setAdditive(previousAdditive)
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  "CostHintsLoader" should "give a run the costs in the statistics of its user's newest completed run of the workflow" in {
    val wid = 9521
    newWorkflow(wid)
    // Each operator costs the most its rows record, neither their sum nor the last one.
    val source = statistics(
      wid,
      952101,
      ("scan", 1_000_000_000L, 500_000_000L),
      ("scan", 3_000_000_000L, 1_000_000_000L),
      ("scan", 2_000_000_000L, 0L),
      ("filter", 250_000_000L, 0L)
    )
    run(952101, wid, runUser, COMPLETED, startedAt = 20)
    // An older completed run of the user, of a larger id: runs are newer by when they started.
    statistics(wid, 952102, ("scan", 1L, 0L))
    run(952102, wid, runUser, COMPLETED, startedAt = 10)
    // The user then edits the workflow, so the runs below are of a newer version than the source
    // is: the source may be of any version of the workflow.
    newVersion(wid)
    // Newer runs that are not the source: another user's completed run...
    statistics(wid, 952103, ("scan", 2L, 0L))
    run(952103, wid, otherUser, COMPLETED, 30)
    // ...the user's runs that did not complete...
    Seq(READY, RUNNING, PAUSED, FAILED, KILLED).zipWithIndex.foreach {
      case (state, index) =>
        val eid = 952104 + index
        statistics(wid, eid, ("scan", 3L, 0L))
        run(eid, wid, runUser, state, 40 + index)
    }
    // ...and the user's completed run of another workflow.
    newWorkflow(9522)
    statistics(9522, 952201, ("scan", 4L, 0L))
    run(952201, 9522, runUser, COMPLETED, 60)
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(952101, "scan" -> 4.0, "filter" -> 0.25)
    loader.opened shouldBe Map(source -> 1)
  }

  it should "choose the run by its closing record: the newest that completed, not a newer one still open or failed" in {
    val wid = 9540
    newWorkflow(wid)
    val source = statistics(wid, 954001, ("scan", 2_000_000_000L, 0L))
    run(954001, wid, runUser, COMPLETED, 10)
    // Newer, with statistics of their own: one still open, one closed as failed.
    statistics(wid, 954002, ("scan", 5L, 0L))
    run(954002, wid, runUser, RUNNING, 20)
    statistics(wid, 954003, ("scan", 6L, 0L))
    run(954003, wid, runUser, FAILED, 30)
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(954001, "scan" -> 2.0)
    loader.opened shouldBe Map(source -> 1)
  }

  it should "find each run's statistics where the run's row says its tables are" in {
    val wid = 9535
    newWorkflow(wid)
    val source = statistics(wid, 953501, ("scan", 1_000_000_000L, 0L))
    run(953501, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(953501, "scan" -> 1.0)

    // A newer run.
    val newer = statistics(wid, 953502, ("scan", 3_000_000_000L, 0L))
    run(953502, wid, runUser, COMPLETED, 20)
    loader.load(wid, runUser) shouldBe hintsOf(953502, "scan" -> 3.0)
    loader.opened shouldBe Map(source -> 1, newer -> 1)
  }

  it should "keep the costs of a run it has read, and not read its statistics again" in {
    val wid = 9523
    val source = onlyCompletedRun(wid, ("scan", 2_000_000_000L, 0L))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(952301, "scan" -> 2.0)
    loader.load(wid, runUser) shouldBe hintsOf(952301, "scan" -> 2.0)
    loader.opened shouldBe Map(source -> 1)
  }

  it should "read the run that completes next, as it becomes the newest" in {
    val wid = 9524
    newWorkflow(wid)
    val first = statistics(wid, 952401, ("scan", 1_000_000_000L, 0L))
    run(952401, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader
    loader.load(wid, runUser) shouldBe hintsOf(952401, "scan" -> 1.0)

    // The user edits the workflow and runs it again: the next run is of the newer version.
    newVersion(wid)
    val next = statistics(wid, 952402, ("scan", 2_000_000_000L, 0L))
    run(952402, wid, runUser, COMPLETED, 20)

    loader.load(wid, runUser) shouldBe hintsOf(952402, "scan" -> 2.0)
    loader.load(wid, runUser) shouldBe hintsOf(952402, "scan" -> 2.0)
    loader.opened shouldBe Map(first -> 1, next -> 1)
  }

  it should "keep the costs of only as many runs as it may, those used most recently" in {
    val (a, b, c) = (9525, 9526, 9527)
    val sources =
      Seq(a, b, c).map(wid => wid -> onlyCompletedRun(wid, ("scan", 1_000_000_000L, 0L))).toMap
    val loader = new CountingLoader(cacheCapacity = 2)

    Seq(a, b, a, c, a, b).foreach { wid =>
      loader.load(wid, runUser) shouldBe hintsOf(wid * 100 + 1, "scan" -> 1.0)
    }
    // a was used just before c came, so c pushed b out, and b was read again
    loader.opened shouldBe Map(sources(a) -> 1, sources(b) -> 2, sources(c) -> 1)
  }

  it should "keep at least one run" in {
    the[IllegalArgumentException] thrownBy new CostHintsLoader(0) should have message
      "requirement failed: Cost hints are kept for at least 1 run, not 0."
  }

  it should "wait for another load's read for some time" in {
    the[IllegalArgumentException] thrownBy new CostHintsLoader(1, 0.seconds) should have message
      "requirement failed: A load waits for another's read for more than no time, not 0 seconds."
  }

  it should "give no hints, and read nothing, when the user has completed no run of the workflow" in {
    val wid = 9528
    newWorkflow(wid)
    statistics(wid, 952801, ("scan", 1L, 0L))
    run(952801, wid, runUser, FAILED, 10)
    statistics(wid, 952802, ("scan", 1L, 0L))
    run(952802, wid, otherUser, COMPLETED, 20)
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe None
    loader.load(9599, runUser) shouldBe None // no such workflow
    loader.load(wid, 9599) shouldBe None // no such user
    loader.opened shouldBe empty
  }

  it should "pass over a run whose id is below 1, which a plan is not saved with the costs of" in {
    val wid = 9529
    newWorkflow(wid)
    val source = statistics(wid, 952901, ("scan", 1_000_000_000L, 0L))
    run(952901, wid, runUser, COMPLETED, 10)
    statistics(wid, 0, ("scan", 5L, 0L))
    run(0, wid, runUser, COMPLETED, 20)
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(952901, "scan" -> 1.0)
    loader.opened shouldBe Map(source -> 1)
  }

  it should "leave out a row of no operator, so a plan is saved with the hints" in {
    val wid = 9530
    newWorkflow(wid)
    statistics(wid, 953001, ("", 5_000_000_000L, 0L), ("scan", 1_000_000_000L, 0L))
    run(953001, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader

    val hints = loader.load(wid, runUser)

    hints shouldBe hintsOf(953001, "scan" -> 1.0)
    val context = new WorkflowContext()
    context.costHints = hints
    val saved = PhysicalPlanCodec.encode(ExecutionPlan(context, PhysicalPlan(Set.empty, Set.empty)))
    PhysicalPlanCodec.decode(saved).context.costHints shouldBe hints
  }

  it should "give no hints for statistics that name no operator, and read them again next time" in {
    // Not kept: statistics with no cost are cheap to read again, and a later read may find costs.
    val (empty, noOperator) = (9531, 9532)
    val emptySource = onlyCompletedRun(empty)
    val noOperatorSource = onlyCompletedRun(noOperator, ("", 1_000_000_000L, 0L))
    val loader = new CountingLoader

    Seq(empty, noOperator, empty, noOperator).foreach { wid =>
      loader.load(wid, runUser) shouldBe None
    }
    loader.opened shouldBe Map(emptySource -> 2, noOperatorSource -> 2)
  }

  it should "give no hints, and read nothing, for statistics in a per-user warehouse while those are disabled" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    val wid = 9533
    newWorkflow(wid)
    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(runUser)
    warehouse.setName("cost-hints-warehouse")
    warehouse.setLakekeeperWarehouseName(s"user-$runUser-1")
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    run(953301, wid, runUser, COMPLETED, 10, whid = Some(warehouse.getWhid))
    // The shared warehouse has statistics under the run's name, which are not the run's.
    statistics(wid, 953301, ("scan", 9_000_000_000L, 0L))
    val loader = new CountingLoader

    val logged = loggedBy(loader) { loader.load(wid, runUser) shouldBe None }

    logged.map(_.getFormattedMessage) shouldBe Seq(
      "The statistics of execution 953301 are not read for cost hints: they are in a per-user " +
        "warehouse, and per-user warehouses are disabled."
    )
    loader.opened shouldBe empty
  }

  it should "give no hints when the statistics cannot be read, and read them once they can be" in {
    val wid = 9534
    val source = onlyCompletedRun(wid, ("scan", 2_000_000_000L, 0L))
    val loader = new CountingLoader
    loader.failing.set(true)

    loader.load(wid, runUser) shouldBe None

    loader.failing.set(false)
    loader.load(wid, runUser) shouldBe hintsOf(953401, "scan" -> 2.0)
    loader.opened shouldBe Map(source -> 2)
  }

  it should "give no hints, and no warning, for a run whose statistics table is gone, and read once there is one" in {
    // As the statistics of an execution whose tables were dropped: nothing there is an answer.
    val wid = 9542
    newWorkflow(wid)
    val missing = statisticsUri(wid, 954201)
    dropStatistics(missing)
    run(954201, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader

    val logged = loggedBy(loader) { loader.load(wid, runUser) shouldBe None }
    logged.filter(_.getLevel.isGreaterOrEqual(Level.WARN)) shouldBe empty

    statistics(wid, 954201, ("scan", 2_000_000_000L, 0L))
    loader.load(wid, runUser) shouldBe hintsOf(954201, "scan" -> 2.0)
    loader.opened shouldBe Map(missing.toString -> 2)
  }

  it should "give no hints, and no warning, for a run whose statistics were stored before a run's record stored them" in {
    // An execution made before the upgrade: its table is where the store reads, with other
    // columns. It has no cost for the next run, and is no failure to warn of.
    val wid = 9541
    newWorkflow(wid)
    val earlier = statisticsOfAnEarlierVersion(wid, 954101)
    run(954101, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader

    val logged = loggedBy(loader) { loader.load(wid, runUser) shouldBe None }

    logged.filter(_.getLevel.isGreaterOrEqual(Level.WARN)) shouldBe empty
    loader.opened shouldBe Map(earlier -> 1)
    // The run after the upgrade is the one read from then on.
    statistics(wid, 954102, ("scan", 1_000_000_000L, 0L))
    run(954102, wid, runUser, COMPLETED, 20)
    loader.load(wid, runUser) shouldBe hintsOf(954102, "scan" -> 1.0)
  }

  it should "warn in one line that the statistics cannot be read, with the stack trace at debug level" in {
    // A read that fails is not kept, so every start of the workflow by the user reads and warns
    // again: the warnings stay one line each.
    val wid = 9536
    newWorkflow(wid)
    val missing = statisticsUri(wid, 953601)
    dropStatistics(missing)
    run(953601, wid, runUser, COMPLETED, 10)
    val loader = new CountingLoader
    loader.failing.set(true)

    val logged = loggedBy(loader) { loader.load(wid, runUser) shouldBe None }

    logged.map(_.getLevel) shouldBe Seq(Level.WARN, Level.DEBUG)
    val (warning, trace) = (logged.head, logged.last)
    warning.getFormattedMessage should startWith(
      s"The cost hints of a run of workflow $wid by user $runUser cannot be read"
    )
    warning.getThrowableProxy shouldBe null
    trace.getThrowableProxy should not be null
    // the warning names the failure whose stack trace is at debug level
    warning.getFormattedMessage should include(trace.getThrowableProxy.getClassName)
    loader.opened shouldBe Map(missing.toString -> 1)
  }

  it should "give no hints for a workflow id no workflow can have" in {
    val loader = new CountingLoader
    loader.load(Int.MaxValue.toLong + 1, runUser) shouldBe None
    loader.opened shouldBe empty
  }

  it should "read a run's statistics once for the loads that miss it at the same time" in {
    val wid = 9537
    onlyCompletedRun(wid, ("scan", 2_000_000_000L, 0L))
    val loader = new GatedLoader

    val loads = overlappingLoads(loader, wid, others = 3)

    loads.map(_.hints.get()).distinct shouldBe Seq(hintsOf(953701, "scan" -> 2.0))
    loader.opened.get() shouldBe 1
    // And kept: a later load reads nothing.
    loader.load(wid, runUser) shouldBe hintsOf(953701, "scan" -> 2.0)
    loader.opened.get() shouldBe 1
  }

  it should "give the loads that waited for a read that failed no hints, and read again after" in {
    val wid = 9538
    onlyCompletedRun(wid, ("scan", 3_000_000_000L, 0L))
    val loader = new GatedLoader
    loader.failing = true

    val loads = overlappingLoads(loader, wid, others = 2)

    loads.map(_.hints.get()).distinct shouldBe Seq(None)
    loader.opened.get() shouldBe 1
    // A read that failed is not kept, so the next load reads again.
    loader.failing = false
    loader.load(wid, runUser) shouldBe hintsOf(953801, "scan" -> 3.0)
    loader.opened.get() shouldBe 2
  }

  it should "give a load that waits for another's read longer than its limit no hints, and keep the read's costs" in {
    val wid = 9539
    onlyCompletedRun(wid, ("scan", 4_000_000_000L, 0L))
    val loader = new GatedLoader(waitLimit = 200.millis)
    val reader = new LoadingThread(loader, wid)
    loader.reading.await(30, TimeUnit.SECONDS) shouldBe true

    try {
      // The read is held at the gate: the waiting load gives up after the limit, reading nothing.
      val logged = loggedBy(loader) { loader.load(wid, runUser) shouldBe None }

      logged.filter(_.getLevel == Level.WARN).map(_.getFormattedMessage) shouldBe Seq(
        "The statistics of execution 953901 are still being read for cost hints after 200 " +
          "milliseconds, so the run is scheduled without them."
      )
      loader.opened.get() shouldBe 1
      reader.isAlive shouldBe true
    } finally loader.gate.countDown()
    reader.join(30000)

    reader.hints.get() shouldBe hintsOf(953901, "scan" -> 4.0)
    // The read went on, and what it found is kept for the loads after it.
    loader.load(wid, runUser) shouldBe hintsOf(953901, "scan" -> 4.0)
    loader.opened.get() shouldBe 1
  }
}
