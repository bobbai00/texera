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
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.storage.{DocumentFactory, VFSURIFactory}
import org.apache.texera.amber.core.tuple.Tuple
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
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.{WORKFLOW_EXECUTIONS, WORKFLOW_VERSION}
import org.apache.texera.dao.jooq.generated.enums.UserRoleEnum
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
import java.util.concurrent.atomic.{AtomicInteger, AtomicReference}
import java.util.concurrent.{CompletableFuture, CountDownLatch, TimeUnit}
import scala.collection.mutable
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * The cost hints a run is given: the costs in the statistics of its user's newest completed run
  * of the workflow, read once per run.
  *
  * Runs are rows of `MockTexeraDB`; their statistics are tables of the Iceberg catalog the tests
  * run with (`STORAGE_ICEBERG_CATALOG_TYPE=postgres`). Each case has workflows of its own, with
  * ids from 9521 to 9539 that no other suite uses, and a run's id is its workflow's id times 100
  * plus a number: creating a statistics table replaces the one of the same workflow and run, and
  * suites share the catalog. The cases of loads at the same time (workflows 9537 to 9539) hold
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
    * Adds run `eid` of workflow `wid` by user `uid`, in `state`, started `startedAt` seconds after
    * the first start, whose statistics are at `statistics` (None: it recorded none). Like a run
    * the service starts, it is of the workflow's latest version.
    */
  private def run(
      eid: Int,
      wid: Int,
      uid: Int,
      state: WorkflowAggregatedState,
      startedAt: Int,
      statistics: Option[String]
  ): Unit = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .orderBy(WORKFLOW_VERSION.VID.desc())
      .limit(1)
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(uid))
      .set(WORKFLOW_EXECUTIONS.STATUS, java.lang.Short.valueOf(maptoStatusCode(state).toShort))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, new Timestamp(firstStart + startedAt * 1000L))
      .set(WORKFLOW_EXECUTIONS.NAME, s"cost-hints-run-$eid")
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.RUNTIME_STATS_URI, statistics.orNull)
      .execute()
  }

  private def statisticsUri(wid: Int, eid: Int): URI =
    VFSURIFactory.createRuntimeStatisticsURI(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(eid.toLong)
    )

  /**
    * Creates the statistics of run `eid` of workflow `wid`, a row for each of `rows`: an
    * operator's id, and the nanoseconds it spent processing data and control messages. Returns
    * where they are.
    */
  private def statistics(wid: Int, eid: Int, rows: (String, Long, Long)*): String = {
    val uri = statisticsUri(wid, eid)
    tables += uri
    val writer = DocumentFactory
      .createDocument(uri, ResultSchema.runtimeStatisticsSchema)
      .writer("cost-hints-spec")
      .asInstanceOf[BufferedItemWriter[Tuple]]
    writer.open()
    rows.foreach {
      case (operatorId, dataNanos, controlNanos) =>
        writer.putOne(
          new Tuple(
            ResultSchema.runtimeStatisticsSchema,
            Array(
              operatorId,
              new Timestamp(firstStart),
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
          )
        )
    }
    writer.close()
    uri.toString
  }

  private def dropStatistics(uri: URI): Unit =
    Try(DocumentFactory.openDocument(uri)._1.clear())

  /**
    * Adds workflow `wid` and its one run, `wid` times 100 plus 1, completed by the run's user,
    * whose statistics hold `rows`. Returns where they are.
    */
  private def onlyCompletedRun(wid: Int, rows: (String, Long, Long)*): String = {
    newWorkflow(wid)
    val eid = wid * 100 + 1
    val source = statistics(wid, eid, rows: _*)
    run(eid, wid, runUser, COMPLETED, 10, Some(source))
    source
  }

  /** Cost hints of run `eid` giving each named operator its seconds. */
  private def hintsOf(eid: Int, seconds: (String, Double)*): Option[CostHints] =
    Some(CostHints(ExecutionIdentity(eid.toLong), seconds.toMap))

  /** A loader that counts how often it opens the statistics at each location. */
  private final class CountingLoader(
      cacheCapacity: Int = 256,
      val opened: mutable.Map[String, Int] = mutable.Map.empty[String, Int].withDefaultValue(0)
  ) extends CostHintsLoader(
        cacheCapacity,
        openStatistics = uri => {
          opened(uri.toString) += 1
          CostHintsLoader.statisticsAt(uri)
        }
      )

  /** What a [[GatedLoader]]'s reads of statistics wait at, and whether they then fail. */
  private final class Gate {
    val opened = new AtomicInteger()
    val reading = new CountDownLatch(1)
    val gate = new CountDownLatch(1)
    @volatile var failing = false

    def open(uri: URI): Iterator[Tuple] = {
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
    run(952101, wid, runUser, COMPLETED, startedAt = 20, Some(source))
    // An older completed run of the user, of a larger id: runs are newer by when they started.
    run(
      952102,
      wid,
      runUser,
      COMPLETED,
      startedAt = 10,
      Some(statistics(wid, 952102, ("scan", 1L, 0L)))
    )
    // The user then edits the workflow, so the runs below are of a newer version than the source
    // is: the source may be of any version of the workflow.
    newVersion(wid)
    // Newer runs that are not the source: another user's completed run...
    run(952103, wid, otherUser, COMPLETED, 30, Some(statistics(wid, 952103, ("scan", 2L, 0L))))
    // ...the user's runs that did not complete...
    Seq(READY, RUNNING, PAUSED, FAILED, KILLED).zipWithIndex.foreach {
      case (state, index) =>
        val eid = 952104 + index
        run(eid, wid, runUser, state, 40 + index, Some(statistics(wid, eid, ("scan", 3L, 0L))))
    }
    // ...the user's completed runs that recorded no statistics...
    run(952110, wid, runUser, COMPLETED, 50, None)
    run(952111, wid, runUser, COMPLETED, 51, Some(""))
    // ...and the user's completed run of another workflow.
    newWorkflow(9522)
    run(952201, 9522, runUser, COMPLETED, 60, Some(statistics(9522, 952201, ("scan", 4L, 0L))))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(952101, "scan" -> 4.0, "filter" -> 0.25)
    loader.opened shouldBe Map(source -> 1)
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
    run(952401, wid, runUser, COMPLETED, 10, Some(first))
    val loader = new CountingLoader
    loader.load(wid, runUser) shouldBe hintsOf(952401, "scan" -> 1.0)

    // The user edits the workflow and runs it again: the next run is of the newer version.
    newVersion(wid)
    val next = statistics(wid, 952402, ("scan", 2_000_000_000L, 0L))
    run(952402, wid, runUser, COMPLETED, 20, Some(next))

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

  it should "give no hints, and read nothing, when the user has completed no run of the workflow that recorded statistics" in {
    val wid = 9528
    newWorkflow(wid)
    run(952801, wid, runUser, FAILED, 10, Some(statistics(wid, 952801, ("scan", 1L, 0L))))
    run(952802, wid, otherUser, COMPLETED, 20, Some(statistics(wid, 952802, ("scan", 1L, 0L))))
    run(952803, wid, runUser, COMPLETED, 30, None)
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
    run(952901, wid, runUser, COMPLETED, 10, Some(source))
    run(0, wid, runUser, COMPLETED, 20, Some(statistics(wid, 0, ("scan", 5L, 0L))))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe hintsOf(952901, "scan" -> 1.0)
    loader.opened shouldBe Map(source -> 1)
  }

  it should "leave out a row of no operator, so a plan is saved with the hints" in {
    val wid = 9530
    newWorkflow(wid)
    run(
      953001,
      wid,
      runUser,
      COMPLETED,
      10,
      Some(statistics(wid, 953001, ("", 5_000_000_000L, 0L), ("scan", 1_000_000_000L, 0L)))
    )
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
    val inWarehouse = VFSURIFactory.createRuntimeStatisticsURI(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(953301),
      warehouse = Some(s"user-$runUser-1")
    )
    run(953301, wid, runUser, COMPLETED, 10, Some(inWarehouse.toString))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe None
    loader.opened shouldBe empty
  }

  it should "give no hints when the statistics cannot be read, and read them once they can be" in {
    val wid = 9534
    newWorkflow(wid)
    val missing = statisticsUri(wid, 953401)
    dropStatistics(missing)
    run(953401, wid, runUser, COMPLETED, 10, Some(missing.toString))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe None

    statistics(wid, 953401, ("scan", 2_000_000_000L, 0L))
    loader.load(wid, runUser) shouldBe hintsOf(953401, "scan" -> 2.0)
    loader.opened shouldBe Map(missing.toString -> 2)
  }

  it should "warn in one line that the statistics cannot be read, with the stack trace at debug level" in {
    // A read that fails is not kept, so every start of the workflow by the user reads and warns
    // again: the warnings stay one line each.
    val wid = 9536
    newWorkflow(wid)
    val missing = statisticsUri(wid, 953601)
    dropStatistics(missing)
    run(953601, wid, runUser, COMPLETED, 10, Some(missing.toString))
    val loader = new CountingLoader

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

  it should "give no hints, and read nothing, when the statistics' location is not a URI" in {
    val wid = 9535
    newWorkflow(wid)
    run(953501, wid, runUser, COMPLETED, 10, Some("::not a URI"))
    val loader = new CountingLoader

    loader.load(wid, runUser) shouldBe None
    loader.opened shouldBe empty
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
