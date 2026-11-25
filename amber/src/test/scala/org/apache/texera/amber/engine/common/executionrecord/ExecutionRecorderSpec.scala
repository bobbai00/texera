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

package org.apache.texera.amber.engine.common.executionrecord

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import com.google.protobuf.timestamp.Timestamp
import org.apache.iceberg.Table
import org.apache.iceberg.catalog.TableIdentifier
import org.apache.iceberg.exceptions.{
  ForbiddenException,
  NoSuchNamespaceException,
  NotAuthorizedException,
  ServiceFailureException
}
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  DocumentFactory,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  ExecutionNamespace,
  IcebergCatalogInstance,
  NoSuchExecutionTableException,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore,
  VFSURIFactory
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  READY,
  RUNNING,
  UNINITIALIZED
}
import org.apache.texera.amber.engine.architecture.worker.statistics.{
  PortTupleMetricsMapping,
  TupleMetrics
}
import org.apache.texera.amber.engine.common.executionruntimestate.{
  OperatorMetrics,
  OperatorStatistics
}
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.common.config.StorageConfig
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}
import org.slf4j.LoggerFactory

import java.io.{IOException, UncheckedIOException}
import java.net.URI
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger, AtomicLong}
import java.util.concurrent.{ConcurrentLinkedQueue, CountDownLatch, Executors, TimeUnit}
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Specs for the recorder that writes a run's record: its log, its statistics and its console.
  * Its tables are real ones, of executions of a workflow of this suite's own, in the catalog the
  * build's tests use: each execution's namespace is made as the Dashboard service makes it, and
  * is dropped, with the tables in it, after the suite. Unless a case says otherwise the recorder
  * ticks only when the case asks it to, on a clock the case sets, and the stores it writes to
  * are the lake's, at most wrapped to count, slow or fail a call.
  */
class ExecutionRecorderSpec
    extends AnyFlatSpec
    with Matchers
    with Eventually
    with BeforeAndAfterAll {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(20, Millis))

  private val workflowId = WorkflowIdentity(9661)
  private val nextExecutionId = new AtomicLong(966100)
  private val madeLogs = new ConcurrentLinkedQueue[URI]()

  private val startedAtMs = 1794873600000L
  private val beatEveryMs = 30000L

  override protected def afterAll(): Unit = {
    madeLogs.asScala.foreach(uri => Try(TestUtils.dropExecutionNamespace(executionIdOf(uri))))
    super.afterAll()
  }

  /** The log of an execution no other case names, whose namespace is made. */
  private def freshLog(): URI = {
    val eid = nextExecutionId.getAndIncrement()
    TestUtils.makeExecutionNamespace(eid)
    val uri = ExecutionLogStore.logUri(workflowId, ExecutionIdentity(eid), None)
    madeLogs.add(uri)
    uri
  }

  /** The execution whose log is at `uri`, a URI of `/wid/<wid>/eid/<eid>/executionlog`. */
  private def executionIdOf(uri: URI): Long = uri.getPath.split("/")(4).toLong

  /** The statistics table of the execution whose log is at `logUri`. */
  private def statisticsUriOf(logUri: URI): URI =
    RuntimeStatisticsStore.statisticsUri(
      workflowId,
      ExecutionIdentity(executionIdOf(logUri)),
      None
    )

  /** The console table of the execution whose log is at `logUri`. */
  private def consoleUriOf(logUri: URI): URI =
    ConsoleMessageStore.consoleUri(workflowId, ExecutionIdentity(executionIdOf(logUri)), None)

  /** Runs `body`, and answers the level and the message of every line the recorder logged. */
  private def logged(body: => Unit): Seq[(Level, String)] = {
    val logger =
      LoggerFactory.getLogger(classOf[LakeExecutionRecorder]).asInstanceOf[LogbackLogger]
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

  /** What a recorder under test writes to, and when: the lake, unless a case replaces a call. */
  private final class Fixture(
      val uri: URI = freshLog(),
      timed: Boolean = false,
      beatEveryMs: Long = beatEveryMs,
      endRetryMs: Long = ExecutionRecorder.EndRetryMs,
      tidyEveryAppends: Int = ExecutionRecorder.TidyEveryAppends,
      consoleBatchRows: Int = ExecutionRecorder.ConsoleBatchRows,
      consoleCapacity: Int = ExecutionRecorder.ConsoleCapacity,
      create: (URI, Long, Long) => Unit = ExecutionLogStore.create,
      append: (URI, Seq[ExecutionLogEntry], Long) => Unit = ExecutionLogStore.append,
      beat: (URI, Long) => Unit = ExecutionLogStore.beat,
      tidy: (URI, Boolean) => Unit = ExecutionLogStore.tidy,
      appendStatistics: (URI, Seq[RuntimeStatisticsRow]) => Unit = RuntimeStatisticsStore.append,
      tidyStatistics: (URI, Boolean) => Unit = RuntimeStatisticsStore.tidy,
      createConsole: URI => Unit = ConsoleMessageStore.create,
      appendConsole: (URI, Seq[ConsoleRow]) => Unit = ConsoleMessageStore.append,
      tidyConsole: (URI, Boolean) => Unit = ConsoleMessageStore.tidy
  ) {
    val statisticsUri: URI = statisticsUriOf(uri)
    val consoleUri: URI = consoleUriOf(uri)
    val clock = new AtomicLong(startedAtMs)

    /** The seq of the rows of each append to the log that was made. */
    val appended = new ConcurrentLinkedQueue[Seq[Long]]()

    /** The rows of each append to the statistics that was made. */
    val statisticsAppended = new ConcurrentLinkedQueue[Seq[RuntimeStatisticsRow]]()

    /** The seq of the rows of each append to the console that was made. */
    val consoleAppended = new ConcurrentLinkedQueue[Seq[Long]]()

    /** Every write that was asked for, made or not, in order: `<table>.<what>`. */
    val asked = new ConcurrentLinkedQueue[String]()

    /** The thread of every write. */
    val writers = new ConcurrentLinkedQueue[Thread]()
    val beats = new AtomicInteger()

    private def onWriter[T](what: String)(write: => T): T = {
      asked.add(what)
      writers.add(Thread.currentThread())
      write
    }

    private def tidying(table: String, tidy: (URI, Boolean) => Unit): (URI, Boolean) => Unit =
      (uri, atEnd) => onWriter(s"$table.${if (atEnd) "tidy-for-end" else "tidy"}")(tidy(uri, atEnd))

    val recorder = new LakeExecutionRecorder(
      logUri = uri,
      statisticsUri = statisticsUri,
      consoleUri = consoleUri,
      beatEveryMs = beatEveryMs,
      timed = timed,
      endRetryMs = endRetryMs,
      tidyEveryAppends = tidyEveryAppends,
      consoleBatchRows = consoleBatchRows,
      consoleCapacity = consoleCapacity,
      clock = () => clock.get(),
      create = (uri, nowMs, every) => onWriter("log.create")(create(uri, nowMs, every)),
      append = (uri, rows, nowMs) =>
        onWriter("log.append") {
          append(uri, rows, nowMs)
          appended.add(rows.map(_.seq))
        },
      beat = (uri, nowMs) =>
        onWriter("log.beat") {
          beat(uri, nowMs)
          beats.incrementAndGet()
        },
      tidy = tidying("log", tidy),
      createStatistics = uri => onWriter("statistics.create")(RuntimeStatisticsStore.create(uri)),
      appendStatistics = (uri, rows) =>
        onWriter("statistics.append") {
          appendStatistics(uri, rows)
          statisticsAppended.add(rows)
        },
      tidyStatistics = tidying("statistics", tidyStatistics),
      createConsole = uri => onWriter("console.create")(createConsole(uri)),
      appendConsole = (uri, rows) =>
        onWriter("console.append") {
          appendConsole(uri, rows)
          consoleAppended.add(rows.map(_.seq))
        },
      tidyConsole = tidying("console", tidyConsole)
    )

    /** Tells the recorder of a change of state a second after the one before, and waits for it. */
    def told(state: String, reason: Option[String] = None): Unit = {
      clock.addAndGet(1000)
      recorder.state(state, reason = reason)
      recorder.awaitIdle(30.seconds) shouldBe true
    }

    /** One tick, a beat's time after the last thing that happened. */
    def tick(): Unit = {
      clock.addAndGet(beatEveryMs)
      recorder.tick()
    }

    def rows: Seq[(Long, String, Option[String])] =
      ExecutionLogStore.read(uri).map(row => (row.seq, row.state.get, row.reason))

    def label: ExecutionLabel = ExecutionLogStore.label(uri).getOrElse(fail(s"no log at $uri"))

    /** The statistics the lake holds, in the order they were stored. */
    def statistics: Seq[RuntimeStatisticsRow] = RuntimeStatisticsStore.read(statisticsUri)

    /** The console the lake holds, by seq. */
    def console: Seq[ConsoleRow] =
      ConsoleMessageStore.read(consoleUri, None, 0, Int.MaxValue)._1

    /**
      * The table at `of`, one of the recorder's three, as the catalog has it now: in the
      * namespace of its execution, named after its URI.
      */
    def tableAt(of: URI): Table = {
      val eid = VFSURIFactory.decodeURI(of).executionId.id
      val name = of.getPath.stripPrefix("/").replace("/", "_")
      IcebergCatalogInstance
        .getInstance(execution = Some(eid))
        .loadTable(TableIdentifier.of(ExecutionNamespace.of(eid), name))
    }

    def table: Table = tableAt(uri)

    def snapshotCount: Int = snapshotCount(uri)

    def snapshotCount(of: URI): Int = tableAt(of).snapshots().asScala.size

    def dataFileCount: Int = dataFileCount(uri)

    /** The data files of the table's current snapshot: none of a table nothing was appended to. */
    def dataFileCount(of: URI): Int =
      Option(tableAt(of).currentSnapshot()).fold(0)(_.summary().get("total-data-files").toInt)

    /** How often a write was asked for. */
    def askedFor(what: String): Int = asked.asScala.count(_ == what)

    /** Whether the recorder's thread is still there. */
    def threadAlive: Boolean = writers.asScala.exists(_.isAlive)
  }

  // What an operator reports, and the row a commit at `timeMs` stores for it: the ports'
  // totals, with times and a worker count a case does not vary.
  private def metrics(
      state: WorkflowAggregatedState,
      in: Long = 0,
      out: Long = 0,
      dataNanos: Long = 0
  ): OperatorMetrics =
    OperatorMetrics(
      state,
      OperatorStatistics(
        Seq(
          PortTupleMetricsMapping(PortIdentity(0), TupleMetrics(in, in * 8)),
          PortTupleMetricsMapping(PortIdentity(1), TupleMetrics(1, 5))
        ),
        Seq(PortTupleMetricsMapping(PortIdentity(0), TupleMetrics(out, out * 9))),
        numWorkers = 2,
        dataProcessingTime = dataNanos,
        controlProcessingTime = 70,
        idleTime = 900
      )
    )

  private def stored(
      operatorId: String,
      timeMs: Long,
      state: WorkflowAggregatedState,
      in: Long = 0,
      out: Long = 0,
      dataNanos: Long = 0
  ): RuntimeStatisticsRow =
    RuntimeStatisticsRow(
      operatorId = operatorId,
      timeMs = timeMs,
      inputTupleCnt = in + 1,
      inputTupleSize = in * 8 + 5,
      outputTupleCnt = out,
      outputTupleSize = out * 9,
      dataProcessingTime = dataNanos,
      controlProcessingTime = 70,
      idleTime = 900,
      numWorkers = 2,
      status = state match {
        case UNINITIALIZED => 0
        case READY         => 0
        case RUNNING       => 1
        case COMPLETED     => 3
        case other         => fail(s"no case stores an operator that is $other")
      }
    )

  /** The `n`th console message of a run, from worker 0 of an operator, a second after the last. */
  private def message(
      n: Int,
      msgType: ConsoleMessageType = ConsoleMessageType.PRINT,
      text: String = ""
  ): ConsoleMessage =
    ConsoleMessage(
      workerId = "Worker:WF9661-udf-main-0",
      timestamp = Timestamp(1794873600L + n, 123000000),
      msgType = msgType,
      source = "udf.py:7",
      title = s"line $n",
      message = text
    )

  /** The row the lake holds of [[message]] `n`, told as the run's `seq`th of `operatorId`. */
  private def consoleRow(
      seq: Long,
      n: Int,
      operatorId: String = "udf",
      msgType: ConsoleMessageType = ConsoleMessageType.PRINT,
      text: String = ""
  ): ConsoleRow =
    ConsoleRow(
      seq,
      (1794873600L + n) * 1000 + 123,
      operatorId,
      "Worker:WF9661-udf-main-0",
      msgType.name,
      "udf.py:7",
      s"line $n",
      text
    )

  private def error(message: String): WorkflowFatalError =
    WorkflowFatalError(EXECUTION_FAILURE, Timestamp(1794873600L, 0), message, "<trace>", "op", "w")

  /** Fails every call it is asked to while it is on, as a lake out of reach does. */
  private final class Outage(startsOn: Boolean = true) {
    val on = new AtomicBoolean(startsOn)
    val calls = new AtomicInteger()
    def unless[T](call: => T): T = {
      calls.incrementAndGet()
      if (on.get()) throw new IllegalStateException("the lake is out of reach") else call
    }
  }

  // ---------------------------------------------------------------------------
  // the rows and the label
  // ---------------------------------------------------------------------------

  "A recorder" should "make the run's log as it starts, with a beat and no state" in {
    // Whatever an earlier database left at the execution's name is replaced.
    val uri = freshLog()
    ExecutionLogStore.create(uri, 1L, 7L)
    ExecutionLogStore.append(uri, Seq(ExecutionLogEntry.state(1, 1L, "FAILED")), 1L)

    val f = new Fixture(uri)
    f.recorder.tick()

    f.label shouldBe ExecutionLabel(None, 0, 0, None, startedAtMs, beatEveryMs)
    f.rows shouldBe empty
  }

  it should "write a row for each change of state, at once, and label the log with each in its turn" in {
    val f = new Fixture()
    val run = Seq("READY", "RUNNING", "PAUSED", "RUNNING", "COMPLETED")

    run.zipWithIndex.foreach {
      case (state, index) =>
        val seq = index + 1L
        f.told(state)
        withClue(s"after $state: ") {
          f.rows shouldBe run.take(index + 1).zipWithIndex.map {
            case (written, at) => (at + 1L, written, None)
          }
          f.label shouldBe ExecutionLabel(
            Some(state),
            seq,
            startedAtMs + seq * 1000,
            None,
            startedAtMs + seq * 1000,
            beatEveryMs
          )
        }
    }
    f.label.ended shouldBe true
    // A commit for each change, and never the caller's thread.
    f.appended.asScala.toSeq shouldBe (1L to 5L).map(Seq(_))
    f.writers.asScala.toSet should have size 1
    f.writers.asScala.map(_.getName).toSet shouldBe
      Set(s"execution-record-${executionIdOf(f.uri)}")
    f.writers.asScala should not contain Thread.currentThread()
  }

  it should "say why a state changed, in the row and in the label" in {
    val failed = new Fixture()
    failed.told("RUNNING")
    failed.clock.addAndGet(1000)
    failed.recorder.state("FAILED", errors = Seq(error("the worker lost its input"), error("x")))
    failed.recorder.awaitIdle(30.seconds) shouldBe true

    failed.rows.last shouldBe ((2L, "FAILED", Some("the worker lost its input")))
    failed.label.reason shouldBe Some("the worker lost its input")
    ExecutionLogStore.read(failed.uri).last.detail.get should
      (include("<trace>") and include(""""message":"x""""))

    val killed = new Fixture()
    killed.told("PAUSED")
    killed.told("KILLED", reason = Some("stopped: nobody watched it for 30 s"))

    killed.rows.last shouldBe ((2L, "KILLED", Some("stopped: nobody watched it for 30 s")))
    killed.label.reason shouldBe Some("stopped: nobody watched it for 30 s")
  }

  it should "write one row when a state is reported twice" in {
    val f = new Fixture()

    f.told("READY")
    f.told("RUNNING")
    f.told("RUNNING", reason = Some("reported again"))
    f.told("PAUSED")

    f.rows shouldBe Seq((1L, "READY", None), (2L, "RUNNING", None), (3L, "PAUSED", None))
    f.label.stateTimeMs shouldBe startedAtMs + 4000
  }

  it should "write nothing after the run's ending" in {
    val f = new Fixture()
    f.told("RUNNING")
    f.told("COMPLETED")
    val ended = f.label

    f.recorder.state("KILLED", reason = Some("killed by the user"))
    f.recorder.state("RUNNING")
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.recorder.tick()

    f.rows shouldBe Seq((1L, "RUNNING", None), (2L, "COMPLETED", None))
    f.label shouldBe ended
  }

  // ---------------------------------------------------------------------------
  // the tick
  // ---------------------------------------------------------------------------

  "A tick" should "move the beat alone, in a commit that adds no snapshot" in {
    val f = new Fixture()
    f.told("RUNNING", reason = Some("resumed"))
    val before = f.label
    val snapshot = f.table.currentSnapshot().snapshotId()

    f.tick()
    f.tick()

    f.label shouldBe before.copy(beatMs = before.beatMs + 2 * beatEveryMs)
    f.snapshotCount shouldBe 1
    f.table.currentSnapshot().snapshotId() shouldBe snapshot
    f.beats.get() shouldBe 2
  }

  it should "write a row whose append failed, before the rows that came after it" in {
    val failOnce = new AtomicBoolean(true)
    val f = new Fixture(
      append = (uri, rows, nowMs) =>
        if (failOnce.getAndSet(false)) throw new IllegalStateException("the commit was refused")
        else ExecutionLogStore.append(uri, rows, nowMs)
    )
    f.clock.addAndGet(1000)
    f.recorder.state("READY")
    // The row stays to be written: the recorder has something left to write.
    f.recorder.awaitIdle(200.millis) shouldBe false
    f.rows shouldBe empty
    f.clock.addAndGet(1000)
    f.recorder.state("RUNNING")

    f.recorder.awaitIdle(30.seconds) shouldBe true

    f.rows shouldBe Seq((1L, "READY", None), (2L, "RUNNING", None))
    // Each row keeps the time of its change, whenever it was written.
    ExecutionLogStore.read(f.uri).map(_.timeMs) shouldBe
      Seq(startedAtMs + 1000, startedAtMs + 2000)
    // One commit for both, the older row first.
    f.appended.asScala.toSeq shouldBe Seq(Seq(1L, 2L))
  }

  it should "write on the next tick what a lake out of reach left unwritten, and report the outage once for rows and once for beats" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs)),
      beat = (uri, nowMs) => outage.unless(ExecutionLogStore.beat(uri, nowMs))
    )
    f.recorder.tick()
    val madeAt = f.label.beatMs
    val eid = executionIdOf(f.uri)
    outage.calls.set(0)

    val lines = logged {
      outage.on.set(true)
      f.clock.addAndGet(1000)
      f.recorder.state("READY")
      f.clock.addAndGet(1000)
      f.recorder.state("RUNNING")
      f.tick()
      f.tick()

      // Nothing was written, and nothing was lost.
      f.recorder.awaitIdle(100.millis) shouldBe false
      f.rows shouldBe empty
      f.label.beatMs shouldBe madeAt

      outage.on.set(false)
      f.tick()
    }

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "READY", None), (2L, "RUNNING", None))
    f.label.beatMs shouldBe f.clock.get()
    f.appended.asScala.toSeq shouldBe Seq(Seq(1L, 2L))
    // Six writes failed and two were made: the outage was reported once for the rows and once
    // for the beats, and so was its end.
    outage.calls.get() shouldBe 8
    lines shouldBe Seq(
      (
        Level.WARN,
        s"A write to the log of execution $eid failed; what it left unwritten is tried again on " +
          "every tick."
      ),
      (Level.WARN, s"A beat of execution $eid failed; the next tick beats again."),
      (Level.INFO, s"Execution $eid beats again."),
      (Level.INFO, s"The log of execution $eid is written again.")
    )
  }

  it should "report once that rows cannot be written, though every beat between the tries is made" in {
    // As when the object store is out of reach and the catalog is not.
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs))
    )
    f.recorder.tick()
    val eid = executionIdOf(f.uri)

    val lines = logged {
      outage.on.set(true)
      f.clock.addAndGet(1000)
      f.recorder.state("COMPLETED")
      (1 to 5).foreach(_ => f.tick())
      outage.on.set(false)
      f.tick()
      f.recorder.awaitIdle(30.seconds) shouldBe true
    }

    // The first tick and the six after it each beat.
    f.beats.get() shouldBe 7
    lines shouldBe Seq(
      (
        Level.WARN,
        s"A write to the log of execution $eid failed; what it left unwritten is tried again on " +
          "every tick."
      ),
      (Level.INFO, s"The log of execution $eid is written again.")
    )
  }

  it should "make on a later tick a log that could not be made, and then write what waited for it" in {
    val outage = new Outage
    val f = new Fixture(
      create = (uri, nowMs, every) => outage.unless(ExecutionLogStore.create(uri, nowMs, every))
    )
    f.clock.addAndGet(1000)
    f.recorder.state("READY")
    f.tick()
    ExecutionLogStore.label(f.uri) shouldBe None
    f.recorder.awaitIdle(100.millis) shouldBe false

    outage.on.set(false)
    f.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "READY", None))
    f.label.beatEveryMs shouldBe beatEveryMs
  }

  it should "return normally whatever a write throws, and beat again on the tick after" in {
    val throwing = new AtomicBoolean(true)
    val f = new Fixture(
      beat = (uri, nowMs) =>
        if (throwing.get()) throw new LinkageError("no step expects this")
        else ExecutionLogStore.beat(uri, nowMs)
    )
    f.told("RUNNING")
    val before = f.label.beatMs

    noException should be thrownBy f.tick()
    f.label.beatMs shouldBe before

    throwing.set(false)
    f.tick()
    f.label.beatMs shouldBe before + 2 * beatEveryMs
  }

  it should "keep coming on the recorder's timer after one that failed" in {
    val beatsAsked = new AtomicInteger()
    val f = new Fixture(
      timed = true,
      beatEveryMs = 20,
      beat = (uri, nowMs) =>
        if (beatsAsked.incrementAndGet() <= 2) throw new LinkageError("no step expects this")
        else ExecutionLogStore.beat(uri, nowMs)
    )
    try {
      // The timer's third tick and those after it beat, though its first two threw.
      eventually(f.beats.get() should be >= 3)
      f.clock.addAndGet(5000)
      val beatsBefore = f.beats.get()
      eventually(f.beats.get() should be > beatsBefore)
      eventually(f.label.beatMs shouldBe startedAtMs + 5000)
    } finally {
      f.recorder.state("KILLED")
      f.recorder.awaitIdle(30.seconds) shouldBe true
    }
  }

  // ---------------------------------------------------------------------------
  // the caller, and the recorder's thread
  // ---------------------------------------------------------------------------

  "A caller" should "not wait for the lake, however slow, and find its changes written in the order it made them" in {
    val appending = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val f = new Fixture(append = (uri, rows, nowMs) => {
      appending.countDown()
      release.await(60, TimeUnit.SECONDS)
      ExecutionLogStore.append(uri, rows, nowMs)
    })
    val states = Seq("READY", "RUNNING", "PAUSED", "RUNNING", "PAUSED", "RUNNING", "FAILED")

    val startedAt = System.nanoTime()
    f.recorder.state(states.head)
    // The lake holds the first row's commit back while the run goes on.
    appending.await(30, TimeUnit.SECONDS) shouldBe true
    states.tail.foreach(f.recorder.state(_))
    val took = (System.nanoTime() - startedAt) / 1000000

    // The store has answered nothing yet: no call waited for it.
    took should be < 5000L
    f.appended shouldBe empty
    f.recorder.awaitIdle(100.millis) shouldBe false

    release.countDown()
    f.recorder.awaitIdle(30.seconds) shouldBe true

    f.rows shouldBe states.zipWithIndex.map { case (state, at) => (at + 1L, state, None) }
    // The first row alone, then what queued up behind it in one commit, in the order it came.
    f.appended.asScala.toSeq shouldBe Seq(Seq(1L), 2L to 7L)
    f.writers.asScala.toSet should have size 1
    f.writers.asScala should not contain Thread.currentThread()
  }

  it should "have its changes written once each, in one order, when many threads report at once" in {
    val f = new Fixture()
    val threads = Executors.newFixedThreadPool(8)
    val go = new CountDownLatch(1)
    try {
      val reports = (0 until 8).map { thread =>
        threads.submit(new Runnable {
          override def run(): Unit = {
            go.await()
            (0 until 50).foreach(i =>
              f.recorder.state(if ((thread + i) % 2 == 0) "RUNNING" else "PAUSED")
            )
          }
        })
      }
      go.countDown()
      reports.foreach(_.get(60, TimeUnit.SECONDS))
      f.recorder.state("KILLED")
      f.recorder.awaitIdle(30.seconds) shouldBe true
    } finally threads.shutdownNow()

    val rows = f.rows
    // Every row once, numbered as it was taken: no gap, no repeat, and no two changes to the
    // same state in a row, however the threads interleaved.
    rows.map(_._1) shouldBe (1L to rows.size.toLong)
    rows.last._2 shouldBe "KILLED"
    rows.init.map(_._2).sliding(2).foreach {
      case Seq(earlier, later) => later should not be earlier
      case _                   =>
    }
    rows.init.map(_._2).toSet.subsetOf(Set("RUNNING", "PAUSED")) shouldBe true
    // The appends were made one after another, each carrying on where the one before stopped.
    f.appended.asScala.toSeq.flatten shouldBe rows.map(_._1)
    f.label.stateSeq shouldBe rows.size
    f.writers.asScala.toSet should have size 1
  }

  // ---------------------------------------------------------------------------
  // the end
  // ---------------------------------------------------------------------------

  "An ending" should "tidy the log to one data file and one snapshot, and let the recorder's thread go" in {
    val f = new Fixture()
    Seq("READY", "RUNNING", "PAUSED", "RUNNING").foreach(f.told(_))
    f.dataFileCount shouldBe 4
    f.snapshotCount shouldBe 4

    f.told("KILLED", reason = Some("killed by the user"))

    f.dataFileCount shouldBe 1
    f.snapshotCount shouldBe 1
    f.rows.map(_._2) shouldBe Seq("READY", "RUNNING", "PAUSED", "RUNNING", "KILLED")
    f.label.reason shouldBe Some("killed by the user")
    eventually(f.threadAlive shouldBe false)
    // It beats no more: the run is over.
    val beats = f.beats.get()
    f.tick()
    f.beats.get() shouldBe beats
  }

  it should "be idle only once the log is tidied" in {
    val tidying = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val f = new Fixture(tidy = (uri, atEnd) => {
      tidying.countDown()
      release.await(60, TimeUnit.SECONDS)
      ExecutionLogStore.tidy(uri, atEnd)
    })
    f.told("RUNNING")
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")
    tidying.await(30, TimeUnit.SECONDS) shouldBe true

    // The row is written, and the recorder is not done.
    f.rows.map(_._2) shouldBe Seq("RUNNING", "COMPLETED")
    f.recorder.awaitIdle(200.millis) shouldBe false

    release.countDown()
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.dataFileCount shouldBe 1
  }

  it should "close the log to every later change at once, though it is not written yet" in {
    val outage = new Outage()
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs))
    )
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")
    f.recorder.awaitIdle(200.millis) shouldBe false

    // Reported while the ending waits for the lake: dropped, as one reported after it is written.
    f.recorder.state("KILLED", reason = Some("killed by the user"))
    outage.on.set(false)
    f.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "COMPLETED", None))
    f.label.state shouldBe Some("COMPLETED")
  }

  it should "be tried again soon when it could not be written, not a beat later" in {
    val failures = new AtomicInteger(3)
    val f = new Fixture(
      timed = true,
      // No beat comes while the case runs.
      beatEveryMs = 3600000,
      endRetryMs = 20,
      append = (uri, rows, nowMs) =>
        if (failures.getAndDecrement() > 0)
          throw new IllegalStateException("the commit was refused")
        else ExecutionLogStore.append(uri, rows, nowMs)
    )

    f.recorder.state("RUNNING")
    f.recorder.state("FAILED", errors = Seq(error("boom")))

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "RUNNING", None), (2L, "FAILED", Some("boom")))
    f.label.ended shouldBe true
    eventually(f.threadAlive shouldBe false)
  }

  it should "be tried again for as long as the lake is out of reach, and written once it answers" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs))
    )
    f.told("RUNNING")
    outage.on.set(true)
    outage.calls.set(0)
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")
    f.recorder.awaitIdle(100.millis) shouldBe false
    val endedAtMs = f.clock.get()

    // Hours pass, and every tick tries again: a log without its ending would be read as the
    // log of a run whose unit was lost.
    Seq(2L, 10L, 60L, 24L * 60).foreach { minutes =>
      f.clock.addAndGet(minutes * 60000)
      f.recorder.tick()
      f.recorder.awaitIdle(50.millis) shouldBe false
      f.threadAlive shouldBe true
    }
    outage.calls.get() shouldBe 5
    // The unit beats meanwhile: it is alive, and its run is not over to a reader.
    f.label.beatMs shouldBe f.clock.get()
    f.label.ended shouldBe false

    outage.on.set(false)
    f.recorder.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "RUNNING", None), (2L, "COMPLETED", None))
    f.label.ended shouldBe true
    // The run ended when it did, however late its ending was written.
    f.label.stateTimeMs shouldBe endedAtMs
    eventually(f.threadAlive shouldBe false)
  }

  // ---------------------------------------------------------------------------
  // a log that is gone, and a lake that cannot answer
  // ---------------------------------------------------------------------------

  "A log dropped under its recorder" should "not be made again, and the recorder stop" in {
    val f = new Fixture()
    f.told("READY")
    f.told("RUNNING")
    // As the Dashboard drops the tables of an execution that is deleted.
    ExecutionLogStore.drop(f.uri)

    f.tick()

    ExecutionLogStore.label(f.uri) shouldBe None
    eventually(f.threadAlive shouldBe false)
    // What the run does after that is dropped, and nothing waits to be written.
    f.recorder.state("COMPLETED")
    f.recorder.awaitIdle(1.second) shouldBe true
    f.tick()
    ExecutionLogStore.label(f.uri) shouldBe None
    ExecutionLogStore.read(f.uri) shouldBe empty
  }

  it should "stop the recorder when it is a row that finds it gone" in {
    val f = new Fixture()
    f.told("READY")
    ExecutionLogStore.drop(f.uri)

    f.clock.addAndGet(1000)
    f.recorder.state("RUNNING")

    f.recorder.awaitIdle(30.seconds) shouldBe true
    ExecutionLogStore.label(f.uri) shouldBe None
    eventually(f.threadAlive shouldBe false)
  }

  "A log the lake cannot answer for" should "not be taken for one that is gone: the recorder goes on" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs)),
      beat = (uri, nowMs) => outage.unless(ExecutionLogStore.beat(uri, nowMs))
    )
    f.told("READY")

    outage.on.set(true)
    f.tick()
    f.clock.addAndGet(1000)
    f.recorder.state("RUNNING")
    f.tick()
    f.threadAlive shouldBe true
    outage.on.set(false)
    f.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.rows shouldBe Seq((1L, "READY", None), (2L, "RUNNING", None))
    f.label.beatMs shouldBe f.clock.get()
  }

  it should "be told apart from a missing one by what the store throws" in {
    // The seam's own word for a table that is gone stops the recorder; any other failure does not.
    val gone = new AtomicBoolean(false)
    val f = new Fixture(
      beat = (uri, nowMs) =>
        if (gone.get()) throw new NoSuchExecutionTableException(uri)
        else ExecutionLogStore.beat(uri, nowMs)
    )
    f.told("RUNNING")
    f.tick()
    f.threadAlive shouldBe true

    gone.set(true)
    f.tick()

    eventually(f.threadAlive shouldBe false)
    // The table itself is as it was: the recorder only stopped.
    f.rows shouldBe Seq((1L, "RUNNING", None))
  }

  // ---------------------------------------------------------------------------
  // a lake that refuses the record
  // ---------------------------------------------------------------------------

  /** What a recorder says as it stops for a lake that refuses the record of execution `eid`. */
  private def refusedLine(eid: Long): (Level, String) =
    (
      Level.WARN,
      s"The lake refuses the record of execution $eid, as it does once the execution's access " +
        "to it has ended: the record is written no more."
    )

  /**
    * What the catalog's client throws once a run's access to the lake has ended, by what it says:
    * the token is refused, or the execution's namespace is gone. A write to the object store,
    * which the catalog signs, finds the catalog's answer wrapped.
    */
  private val refusals: Seq[(String, () => Throwable)] = Seq(
    "a token the catalog refuses" ->
      (() => new ForbiddenException("Forbidden: the token may not write here")),
    "a token the catalog no longer takes" ->
      (() => new NotAuthorizedException("Not authorized: the token expired")),
    "a namespace that is gone" ->
      (() => new NoSuchNamespaceException("Namespace does not exist: execution-1")),
    "a signature the catalog refuses, under the object store's write" -> (() =>
      new UncheckedIOException(
        new IOException(
          "the upload failed",
          new ForbiddenException("Forbidden: the request may not be signed")
        )
      )
    )
  )

  "A record the lake refuses" should "not be written again, and the recorder stop, whatever the refusal" in {
    refusals.foreach {
      case (refusal, thrown) =>
        withClue(s"$refusal: ") {
          val refused = new AtomicBoolean(false)
          val f = new Fixture(
            beat = (uri, nowMs) =>
              if (refused.get()) throw thrown()
              else ExecutionLogStore.beat(uri, nowMs)
          )
          f.told("RUNNING")
          f.tick()
          f.threadAlive shouldBe true

          val lines = logged {
            refused.set(true)
            f.tick()
            eventually(f.threadAlive shouldBe false)
          }

          // Said once, and the record is as it was: the recorder only stopped.
          lines shouldBe Seq(refusedLine(executionIdOf(f.uri)))
          f.rows shouldBe Seq((1L, "RUNNING", None))
          // What the run does after that is dropped, and nothing waits to be written.
          f.recorder.state("COMPLETED")
          f.recorder.awaitIdle(1.second) shouldBe true
          f.rows shouldBe Seq((1L, "RUNNING", None))
        }
    }
  }

  it should "stop the recorder when it is a row that is refused, also after the run's end" in {
    val refused = new AtomicBoolean(false)
    val f = new Fixture(
      append = (uri, rows, nowMs) =>
        if (refused.get()) throw new ForbiddenException("Forbidden: the token may not write here")
        else ExecutionLogStore.append(uri, rows, nowMs)
    )
    f.told("RUNNING")
    refused.set(true)

    // The end is not tried again every few seconds for as long as the unit lives.
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")

    f.recorder.awaitIdle(30.seconds) shouldBe true
    eventually(f.threadAlive shouldBe false)
    f.rows shouldBe Seq((1L, "RUNNING", None))
    f.label.ended shouldBe false
  }

  it should "stop the recorder as it starts, when the execution has no namespace to make its tables in" in {
    val f = new Fixture(
      create =
        (_, _, _) => throw new NoSuchNamespaceException("Namespace does not exist: execution-1")
    )

    eventually(f.threadAlive shouldBe false)

    // Nothing is made, nor made again, and what the run does is dropped.
    f.recorder.state("READY")
    f.recorder.awaitIdle(1.second) shouldBe true
    f.tick()
    f.askedFor("log.create") shouldBe 1
    f.askedFor("statistics.create") shouldBe 0
    ExecutionLogStore.label(f.uri) shouldBe None
  }

  "A record the lake cannot answer for, without refusing it," should "not be taken for one it refuses: the recorder goes on" in {
    val failing = new AtomicBoolean(true)
    val f = new Fixture(
      beat = (uri, nowMs) =>
        if (failing.get()) throw new ServiceFailureException("Service failed: 503: restarting")
        else ExecutionLogStore.beat(uri, nowMs)
    )
    f.told("RUNNING")

    f.tick()
    f.tick()
    f.threadAlive shouldBe true
    failing.set(false)
    f.tick()

    f.label.beatMs shouldBe f.clock.get()
    f.threadAlive shouldBe true
  }

  // ---------------------------------------------------------------------------
  // statistics
  // ---------------------------------------------------------------------------

  "Statistics" should "be stored at a tick: a row for each operator whose numbers changed since its last row, with the tick's time" in {
    val f = new Fixture()

    // Three reports between two ticks. The sink is in the first alone, the filter in two.
    f.recorder.statistics(
      Map(
        "scan" -> metrics(RUNNING, out = 10, dataNanos = 100),
        "filter" -> metrics(RUNNING, in = 10, out = 4, dataNanos = 40),
        "sink" -> metrics(UNINITIALIZED)
      )
    )
    f.recorder.statistics(
      Map(
        "scan" -> metrics(RUNNING, out = 20, dataNanos = 200),
        "filter" -> metrics(RUNNING, in = 20, out = 9, dataNanos = 90)
      )
    )
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 30, dataNanos = 300)))
    // Kept, not written: nothing is stored between ticks.
    f.statisticsAppended shouldBe empty
    f.tick()

    // One row for each operator, of its newest numbers: an operator a later report left out
    // keeps the numbers it was last told with.
    val firstTick = f.clock.get()
    val first = Seq(
      stored("filter", firstTick, RUNNING, in = 20, out = 9, dataNanos = 90),
      stored("scan", firstTick, RUNNING, out = 30, dataNanos = 300),
      stored("sink", firstTick, UNINITIALIZED)
    )
    f.statistics shouldBe first
    f.statisticsAppended.asScala.toSeq shouldBe Seq(first)

    // The scan's numbers move, the filter's state alone changes, the sink is as it was.
    f.recorder.statistics(
      Map(
        "scan" -> metrics(RUNNING, out = 45, dataNanos = 450),
        "filter" -> metrics(COMPLETED, in = 20, out = 9, dataNanos = 90),
        "sink" -> metrics(UNINITIALIZED)
      )
    )
    f.tick()

    val secondTick = f.clock.get()
    secondTick shouldBe firstTick + beatEveryMs
    val second = Seq(
      stored("filter", secondTick, COMPLETED, in = 20, out = 9, dataNanos = 90),
      stored("scan", secondTick, RUNNING, out = 45, dataNanos = 450)
    )
    f.statistics shouldBe first ++ second

    // The same numbers again, and a tick with no report at all: nothing to store.
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 45, dataNanos = 450)))
    f.tick()
    f.tick()
    f.statistics shouldBe first ++ second
    f.statisticsAppended should have size 2
    f.writers.asScala.toSet should have size 1
    f.writers.asScala should not contain Thread.currentThread()
  }

  it should "be an operator's totals over all of its input ports and all of its output ports" in {
    val f = new Fixture()
    def port(id: Int, count: Long, size: Long): PortTupleMetricsMapping =
      PortTupleMetricsMapping(PortIdentity(id), TupleMetrics(count, size))

    f.recorder.statistics(
      Map(
        "join" -> OperatorMetrics(
          RUNNING,
          OperatorStatistics(
            Seq(port(0, 2, 20), port(1, 3, 35)),
            Seq(port(0, 4, 40), port(1, 5, 55)),
            numWorkers = 2,
            dataProcessingTime = 0,
            controlProcessingTime = 0,
            idleTime = 0
          )
        )
      )
    )
    f.tick()

    f.statistics.map(row =>
      (row.inputTupleCnt, row.inputTupleSize, row.outputTupleCnt, row.outputTupleSize)
    ) shouldBe Seq((5L, 55L, 9L, 95L))
  }

  it should "be stored again, with the numbers that are newest then, after an append that failed" in {
    val outage = new Outage()
    val f = new Fixture(
      appendStatistics = (uri, rows) => outage.unless(RuntimeStatisticsStore.append(uri, rows))
    )
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 10)))
    f.tick()
    f.recorder.awaitIdle(100.millis) shouldBe false
    f.statistics shouldBe empty

    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 25)))
    outage.on.set(false)
    f.tick()

    // One row, of the tick that stored it: the sample that could not be stored is not kept.
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.statistics shouldBe Seq(stored("scan", f.clock.get(), RUNNING, out = 25))
  }

  // ---------------------------------------------------------------------------
  // console
  // ---------------------------------------------------------------------------

  "Console messages" should "be stored whole at a tick, numbered in the order they were told, under their logical operator" in {
    val f = new Fixture()
    val trace = "Traceback (most recent call last):\n" + "  File \"udf.py\", line 7\n" * 2000

    f.recorder.console("udf", message(1))
    f.recorder.console("join", message(2))
    f.recorder.console("udf", message(3, ConsoleMessageType.ERROR, trace))
    f.consoleAppended shouldBe empty
    f.tick()

    f.console shouldBe Seq(
      consoleRow(1, 1),
      consoleRow(2, 2, operatorId = "join"),
      consoleRow(3, 3, msgType = ConsoleMessageType.ERROR, text = trace)
    )
    // One commit for the tick, whatever the number of operators.
    f.consoleAppended.asScala.toSeq shouldBe Seq(Seq(1L, 2L, 3L))

    // The next tick stores what came since, and nothing again.
    f.recorder.console("udf", message(4, ConsoleMessageType.DEBUGGER))
    f.tick()
    f.tick()
    f.console.map(row => (row.seq, row.msgType)) shouldBe
      Seq((1L, "PRINT"), (2L, "PRINT"), (3L, "ERROR"), (4L, "DEBUGGER"))
    f.consoleAppended.asScala.toSeq shouldBe Seq(Seq(1L, 2L, 3L), Seq(4L))
    ConsoleMessageStore.read(f.consoleUri, Some("join"), 0, 10)._1.map(_.seq) shouldBe Seq(2L)
  }

  it should "be stored without waiting for a tick once 4,096 of them wait" in {
    ExecutionRecorder.ConsoleBatchRows shouldBe 4096
    val f = new Fixture()
    f.recorder.tick()
    val beats = f.beats.get()

    (1 to 4095).foreach(n => f.recorder.console("udf", message(n)))
    f.recorder.awaitIdle(200.millis) shouldBe false
    f.consoleAppended shouldBe empty

    f.recorder.console("udf", message(4096))

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.consoleAppended.asScala.toSeq shouldBe Seq(1L to 4096L)
    f.console.map(_.seq) shouldBe (1L to 4096L)
    // No tick came meanwhile, and the next batch waits for its own 4,096th.
    f.beats.get() shouldBe beats
    f.recorder.console("udf", message(4097))
    f.recorder.awaitIdle(200.millis) shouldBe false
  }

  it should "be asked of a lake that is out of reach once for each batch that waits, not for each message" in {
    val outage = new Outage()
    val f = new Fixture(
      consoleBatchRows = 4,
      appendConsole = (uri, rows) => outage.unless(ConsoleMessageStore.append(uri, rows))
    )

    // Asked at the 4th and at the 8th, and at no message between or after.
    (1 to 4).foreach(n => f.recorder.console("udf", message(n)))
    eventually(outage.calls.get() shouldBe 1)
    (5 to 8).foreach(n => f.recorder.console("udf", message(n)))
    eventually(outage.calls.get() shouldBe 2)
    (9 to 11).foreach(n => f.recorder.console("udf", message(n)))
    f.recorder.tick()
    outage.calls.get() shouldBe 3

    outage.on.set(false)
    f.tick()
    f.recorder.awaitIdle(30.seconds) shouldBe true
    // In one commit, each once, in the order they were told.
    f.consoleAppended.asScala.toSeq shouldBe Seq(1L to 11L)
    f.console.map(_.seq) shouldBe (1L to 11L)
  }

  it should "lose the oldest beyond what a recorder holds, and say in a row how many" in {
    ExecutionRecorder.ConsoleCapacity shouldBe 50000
    val outage = new Outage()
    val f = new Fixture(
      consoleCapacity = 5,
      appendConsole = (uri, rows) => outage.unless(ConsoleMessageStore.append(uri, rows))
    )

    // The lake takes nothing while eight messages come, and two more after a tick that failed.
    (1 to 8).foreach(n => f.recorder.console("udf", message(n)))
    f.tick()
    (9 to 10).foreach(n => f.recorder.console("udf", message(n)))
    outage.on.set(false)
    f.tick()

    // The five newest, after a row for the five that were dropped: it takes the place, and the
    // seq, of the last of them, and has the time of the message after it.
    val firstLost = ConsoleRow(
      seq = 5,
      timeMs = consoleRow(6, 6).timeMs,
      operatorId = "",
      workerId = "",
      msgType = "ERROR",
      source = "(engine)",
      title = "5 console messages were not stored",
      message = ""
    )
    f.console shouldBe firstLost +: (6 to 10).map(n => consoleRow(n.toLong, n))

    // Nothing is lost while the lake takes them, however many come.
    (11 to 30).foreach { n =>
      f.recorder.console("udf", message(n))
      if (n % 4 == 0) f.tick()
    }
    f.tick()
    f.console.map(_.seq) shouldBe (5L to 30L)

    // Lost again: the row counts what was lost since the last row stored, not since the start.
    outage.on.set(true)
    (31 to 39).foreach(n => f.recorder.console("udf", message(n)))
    outage.on.set(false)
    f.tick()

    f.console.map(_.seq) shouldBe (5L to 30L) ++ (34L to 39L)
    f.console.filter(_.operatorId.isEmpty).map(row => (row.seq, row.title)) shouldBe Seq(
      (5L, "5 console messages were not stored"),
      (34L, "4 console messages were not stored")
    )
    // An operator's console holds its own messages alone.
    ConsoleMessageStore.read(f.consoleUri, Some("udf"), 0, 100)._1.map(_.seq) shouldBe
      (6L to 30L) ++ (35L to 39L)
  }

  it should "each be stored once, in one order, when many threads tell them while the recorder stores" in {
    val f = new Fixture(consoleBatchRows = 16)
    val threads = Executors.newFixedThreadPool(8)
    val go = new CountDownLatch(1)
    try {
      val tellers = (0 until 8).map { thread =>
        threads.submit(new Runnable {
          override def run(): Unit = {
            go.await()
            (0 until 250).foreach(i => f.recorder.console(s"op-$thread", message(i)))
          }
        })
      }
      go.countDown()
      tellers.foreach(_.get(60, TimeUnit.SECONDS))
      f.recorder.state("KILLED")
      f.recorder.awaitIdle(60.seconds) shouldBe true
    } finally threads.shutdownNow()

    val console = f.console
    console.map(_.seq) shouldBe (1L to 2000L)
    // Each operator's messages in the order its thread told them.
    (0 until 8).foreach { thread =>
      console.filter(_.operatorId == s"op-$thread").map(_.title) shouldBe
        (0 until 250).map(i => s"line $i")
    }
    // The appends carried on from one another: no row twice, none skipped.
    f.consoleAppended.asScala.toSeq.flatten shouldBe (1L to 2000L)
    f.writers.asScala.toSet should have size 1
  }

  // ---------------------------------------------------------------------------
  // a commit, and the tables
  // ---------------------------------------------------------------------------

  "A recorder" should "make the run's statistics and console tables as it starts, empty, in place of what an earlier database left" in {
    val uri = freshLog()
    val (statisticsUri, consoleUri) = (statisticsUriOf(uri), consoleUriOf(uri))
    RuntimeStatisticsStore.create(statisticsUri)
    RuntimeStatisticsStore.append(statisticsUri, Seq(stored("stale", 1L, COMPLETED, out = 7)))
    ConsoleMessageStore.create(consoleUri)
    ConsoleMessageStore.append(consoleUri, Seq(consoleRow(1, 1), consoleRow(2, 2)))

    val f = new Fixture(uri)

    // As it starts, with no tick and nothing told: a reader finds the run's tables at once.
    eventually(
      f.asked.asScala.toSeq shouldBe Seq("log.create", "statistics.create", "console.create")
    )
    // A tick comes after the making of the tables is over.
    f.recorder.tick()
    f.statistics shouldBe empty
    f.console shouldBe empty
    // A run that prints nothing has a console table all the same, with nothing in it.
    f.told("KILLED")
    DocumentFactory.documentExists(consoleUri) shouldBe true
    f.console shouldBe empty
  }

  it should "make on a later tick a table that could not be made, and write the others meanwhile" in {
    val outage = new Outage()
    val f = new Fixture(createConsole = uri => outage.unless(ConsoleMessageStore.create(uri)))
    f.told("RUNNING")
    f.recorder.console("udf", message(1))
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 1)))
    f.tick()

    // The log and the statistics are written though there is no console table.
    f.rows.map(_._2) shouldBe Seq("RUNNING")
    f.statistics should have size 1
    DocumentFactory.documentExists(f.consoleUri) shouldBe false
    f.recorder.awaitIdle(100.millis) shouldBe false

    outage.on.set(false)
    f.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.console.map(_.seq) shouldBe Seq(1L)
  }

  "A change of state" should "store the statistics and the console right after its row, in that order" in {
    val f = new Fixture()
    f.told("RUNNING")
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 10)))
    f.recorder.console("udf", message(1))
    f.recorder.console("udf", message(2))
    f.recorder.awaitIdle(200.millis) shouldBe false
    f.asked.clear()

    f.told("PAUSED")

    // No tick: the change itself commits what waited, with its own time.
    f.asked.asScala.toSeq shouldBe Seq("log.append", "statistics.append", "console.append")
    f.statistics shouldBe Seq(stored("scan", f.clock.get(), RUNNING, out = 10))
    f.console.map(_.seq) shouldBe Seq(1L, 2L)
    f.label.state shouldBe Some("PAUSED")
    f.beats.get() shouldBe 0
  }

  "A tick" should "beat before it stores statistics and console, so an append that fails holds no beat back" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      appendStatistics = (uri, rows) => outage.unless(RuntimeStatisticsStore.append(uri, rows)),
      appendConsole = (uri, rows) => outage.unless(ConsoleMessageStore.append(uri, rows))
    )
    f.told("RUNNING")
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 10)))
    f.recorder.console("udf", message(1))
    outage.on.set(true)
    f.asked.clear()
    val eid = executionIdOf(f.uri)

    val lines = logged {
      f.tick()
      f.tick()

      // Both ticks beat, first of all, though neither could store anything.
      f.asked.asScala.toSeq shouldBe
        Seq.fill(2)(Seq("log.beat", "statistics.append", "console.append")).flatten
      f.label.beatMs shouldBe f.clock.get()
      f.statistics shouldBe empty
      f.console shouldBe empty
      f.recorder.awaitIdle(100.millis) shouldBe false

      outage.on.set(false)
      f.tick()
    }

    // Stored by the tick that could: the statistics with its time.
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.statistics shouldBe Seq(stored("scan", f.clock.get(), RUNNING, out = 10))
    f.console.map(_.seq) shouldBe Seq(1L)
    f.label.beatMs shouldBe f.clock.get()
    // Each kind of write is reported once when it starts to fail, and once when it is made.
    lines shouldBe Seq(
      (
        Level.WARN,
        s"A write to the statistics of execution $eid failed; what it left unwritten is tried " +
          "again on every tick."
      ),
      (
        Level.WARN,
        s"A write to the console output of execution $eid failed; what it left unwritten is " +
          "tried again on every tick."
      ),
      (Level.INFO, s"The statistics of execution $eid are written again."),
      (Level.INFO, s"The console output of execution $eid is written again.")
    )
  }

  it should "return normally whatever a statistics or console append throws, and beat on the tick after" in {
    val throwing = new AtomicBoolean(true)
    val f = new Fixture(
      appendStatistics = (uri, rows) =>
        if (throwing.get()) throw new LinkageError("no step expects this")
        else RuntimeStatisticsStore.append(uri, rows)
    )
    f.told("RUNNING")
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 10)))

    noException should be thrownBy f.tick()
    // The beat came first.
    f.label.beatMs shouldBe f.clock.get()

    throwing.set(false)
    f.tick()
    f.label.beatMs shouldBe f.clock.get()
    f.statistics should have size 1
  }

  "A tidy" should "come after as many appends to a table as the recorder is given, and keep the table's rows in order" in {
    ExecutionRecorder.TidyEveryAppends shouldBe 50
    val f = new Fixture(tidyEveryAppends = 3)

    // Beats are no appends: no number of them tidies anything.
    (1 to 7).foreach(_ => f.tick())
    f.asked.asScala.toSet shouldBe
      Set("log.create", "statistics.create", "console.create", "log.beat")

    // Two ticks that each append to the statistics and to the console.
    (1 to 2).foreach { n =>
      f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = n * 10L)))
      f.recorder.console("udf", message(n))
      f.tick()
    }
    Seq(f.statisticsUri, f.consoleUri).foreach(f.dataFileCount(_) shouldBe 2)
    f.asked.asScala.filter(_.contains("tidy")) shouldBe empty

    // The third append to each makes its tidy due, in the same tick.
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 30)))
    f.recorder.console("udf", message(3))
    f.tick()

    f.asked.asScala.filter(_.contains("tidy")).toSeq shouldBe Seq("statistics.tidy", "console.tidy")
    Seq(f.statisticsUri, f.consoleUri).foreach(f.dataFileCount(_) shouldBe 1)
    f.statistics.map(_.outputTupleCnt) shouldBe Seq(10L, 20L, 30L)
    f.console.map(_.seq) shouldBe Seq(1L, 2L, 3L)

    // The count starts again: two more appends tidy nothing, the third does.
    (4 to 5).foreach { n =>
      f.recorder.console("udf", message(n))
      f.tick()
    }
    f.dataFileCount(f.consoleUri) shouldBe 3
    f.askedFor("console.tidy") shouldBe 1
    f.recorder.console("udf", message(6))
    f.tick()
    f.askedFor("console.tidy") shouldBe 2
    f.dataFileCount(f.consoleUri) shouldBe 1
    f.console.map(_.seq) shouldBe (1L to 6L)
    f.askedFor("statistics.tidy") shouldBe 1

    // The log is tidied by the same count, of its own appends: its changes of state.
    f.askedFor("log.tidy") shouldBe 0
    Seq("RUNNING", "PAUSED").foreach(f.told(_))
    f.dataFileCount shouldBe 2
    f.told("RUNNING")
    f.tick()
    f.askedFor("log.tidy") shouldBe 1
    f.dataFileCount shouldBe 1
    f.rows.map(_._2) shouldBe Seq("RUNNING", "PAUSED", "RUNNING")
    f.label.state shouldBe Some("RUNNING")
  }

  it should "come for a chatty console without a tick, once its batches made it due" in {
    val f = new Fixture(tidyEveryAppends = 3, consoleBatchRows = 2)
    f.recorder.tick()
    val beats = f.beats.get()

    (1 to 6).foreach { n =>
      f.recorder.console("udf", message(n))
      // Each batch is stored before the next message comes.
      if (n % 2 == 0) f.recorder.awaitIdle(30.seconds) shouldBe true
    }

    eventually(f.askedFor("console.tidy") shouldBe 1)
    eventually(f.dataFileCount(f.consoleUri) shouldBe 1)
    f.console.map(_.seq) shouldBe (1L to 6L)
    f.beats.get() shouldBe beats
  }

  it should "be tried again on the next tick when it failed" in {
    val failOnce = new AtomicBoolean(true)
    val f = new Fixture(
      tidyEveryAppends = 2,
      tidyConsole = (uri, atEnd) =>
        if (failOnce.getAndSet(false)) throw new IllegalStateException("the merge was refused")
        else ConsoleMessageStore.tidy(uri, atEnd)
    )
    (1 to 2).foreach { n =>
      f.recorder.console("udf", message(n))
      f.tick()
    }
    f.askedFor("console.tidy") shouldBe 1
    f.dataFileCount(f.consoleUri) shouldBe 2

    f.tick()

    f.askedFor("console.tidy") shouldBe 2
    f.dataFileCount(f.consoleUri) shouldBe 1
  }

  "An ending" should "store what waits, and leave one data file and one snapshot in each table that was written to" in {
    val f = new Fixture()
    f.told("RUNNING")
    (1 to 3).foreach { n =>
      f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = n * 10L)))
      f.recorder.console("udf", message(n))
      f.tick()
    }
    // What the run hands over last, with no tick after it.
    f.recorder.statistics(Map("scan" -> metrics(COMPLETED, out = 40)))
    f.recorder.console("udf", message(4))
    f.asked.clear()

    f.told("COMPLETED")

    val endedAt = f.clock.get()
    f.asked.asScala.toSeq shouldBe Seq(
      "log.append",
      "statistics.append",
      "console.append",
      "log.tidy-for-end",
      "statistics.tidy-for-end",
      "console.tidy-for-end"
    )
    f.statistics.map(row => (row.timeMs, row.outputTupleCnt, row.status)).last shouldBe
      ((endedAt, 40L, 3))
    f.statistics should have size 4
    f.console.map(_.seq) shouldBe Seq(1L, 2L, 3L, 4L)
    Seq(f.uri, f.statisticsUri, f.consoleUri).foreach { table =>
      withClue(s"$table: ") {
        f.dataFileCount(table) shouldBe 1
        f.snapshotCount(table) shouldBe 1
      }
    }
    f.label.ended shouldBe true
    eventually(f.threadAlive shouldBe false)
  }

  it should "leave a table nothing was written to as it was made" in {
    val f = new Fixture()
    f.told("RUNNING")
    f.recorder.statistics(Map("scan" -> metrics(COMPLETED, out = 1)))

    f.told("COMPLETED")

    f.asked.asScala.filter(_.contains("tidy")).toSeq shouldBe
      Seq("log.tidy-for-end", "statistics.tidy-for-end")
    f.console shouldBe empty
    f.snapshotCount(f.consoleUri) shouldBe 0
    f.dataFileCount(f.statisticsUri) shouldBe 1
  }

  it should "be idle only once statistics and console are stored: what could not be stored is tried again, with no beat" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      appendConsole = (uri, rows) => outage.unless(ConsoleMessageStore.append(uri, rows))
    )
    f.told("RUNNING")
    f.tick()
    f.recorder.statistics(Map("scan" -> metrics(COMPLETED, out = 9)))
    f.recorder.console("udf", message(1))
    outage.on.set(true)
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")
    f.recorder.awaitIdle(300.millis) shouldBe false

    // The run's end is in its log, with its statistics; its console is not stored yet.
    f.label.ended shouldBe true
    f.statistics should have size 1
    f.console shouldBe empty
    f.threadAlive shouldBe true
    val beats = f.beats.get()
    f.tick()
    f.recorder.awaitIdle(100.millis) shouldBe false
    // A run whose end is in its log beats no more.
    f.beats.get() shouldBe beats
    f.asked.asScala.filter(_.contains("tidy")) shouldBe empty

    outage.on.set(false)
    f.tick()

    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.console.map(_.seq) shouldBe Seq(1L)
    Seq(f.uri, f.statisticsUri, f.consoleUri).foreach(f.dataFileCount(_) shouldBe 1)
    eventually(f.threadAlive shouldBe false)
  }

  it should "be tried again soon also when its commit threw what no step expects" in {
    val throwing = new AtomicBoolean(true)
    val f = new Fixture(
      timed = true,
      // No beat comes while the case runs.
      beatEveryMs = 3600000,
      endRetryMs = 20,
      appendStatistics = (uri, rows) =>
        if (throwing.getAndSet(false)) throw new LinkageError("no step expects this")
        else RuntimeStatisticsStore.append(uri, rows)
    )
    f.recorder.statistics(Map("scan" -> metrics(COMPLETED, out = 1)))

    f.recorder.state("COMPLETED")

    // The commit that threw wrote the run's end; the next one, soon after, stores the rest.
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.label.ended shouldBe true
    f.statistics should have size 1
    f.dataFileCount(f.statisticsUri) shouldBe 1
    eventually(f.threadAlive shouldBe false)
  }

  it should "close the record to what the run hands over after it, written or not" in {
    val outage = new Outage()
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs))
    )
    f.recorder.console("udf", message(1))
    f.clock.addAndGet(1000)
    f.recorder.state("FAILED")

    // While the ending waits for the lake, and once it is written.
    f.recorder.console("udf", message(2))
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 5)))
    outage.on.set(false)
    f.tick()
    f.recorder.awaitIdle(30.seconds) shouldBe true
    f.recorder.console("udf", message(3))
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 6)))

    f.recorder.awaitIdle(1.second) shouldBe true
    f.console.map(_.seq) shouldBe Seq(1L)
    f.statistics shouldBe empty
  }

  "A statistics or console table dropped under its recorder" should "not be made again, and the recorder stop" in {
    Seq[(String, Fixture => URI)](
      "statistics" -> (_.statisticsUri),
      "console" -> (_.consoleUri)
    ).foreach {
      case (table, uriOf) =>
        withClue(s"the $table table: ") {
          val f = new Fixture()
          f.told("RUNNING")
          f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 1)))
          f.recorder.console("udf", message(1))
          f.tick()
          // As the Dashboard drops the tables of an execution that is deleted.
          val dropped = uriOf(f)
          if (table == "statistics") RuntimeStatisticsStore.drop(dropped)
          else ConsoleMessageStore.drop(dropped)

          f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 2)))
          f.recorder.console("udf", message(2))
          f.tick()

          DocumentFactory.documentExists(dropped) shouldBe false
          eventually(f.threadAlive shouldBe false)
          // Nothing more is written, to any of its tables, and nothing waits.
          f.recorder.state("COMPLETED")
          f.recorder.awaitIdle(1.second) shouldBe true
          f.rows.map(_._2) shouldBe Seq("RUNNING")
        }
    }
  }

  "awaitIdle" should "wait for statistics and console that are not stored yet, as for a change of state" in {
    val f = new Fixture()
    f.recorder.tick()
    f.recorder.awaitIdle(1.second) shouldBe true

    f.recorder.console("udf", message(1))
    f.recorder.awaitIdle(100.millis) shouldBe false
    f.tick()
    f.recorder.awaitIdle(1.second) shouldBe true

    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 1)))
    f.recorder.awaitIdle(100.millis) shouldBe false
    f.tick()
    f.recorder.awaitIdle(1.second) shouldBe true

    // The same numbers again are nothing to store: the tick that looks at them settles it.
    f.recorder.statistics(Map("scan" -> metrics(RUNNING, out = 1)))
    f.tick()
    f.recorder.awaitIdle(1.second) shouldBe true
    f.statisticsAppended should have size 1
  }

  // ---------------------------------------------------------------------------
  // the two recorders a run is given
  // ---------------------------------------------------------------------------

  "ExecutionRecorder.start" should "record the run of a context's execution in its three tables, beating as configured" in {
    val uri = freshLog()
    val eid = uri.getPath.split("/")(4).toLong
    val recorder = ExecutionRecorder.start(
      new WorkflowContext(workflowId = workflowId, executionId = ExecutionIdentity(eid))
    )

    recorder.state("READY")
    recorder.statistics(Map("scan" -> metrics(RUNNING, out = 3)))
    recorder.console("udf", message(1))
    recorder.state("KILLED", reason = Some("replaced by execution 7"))

    recorder.awaitIdle(30.seconds) shouldBe true
    ExecutionLogStore.read(uri).map(row => (row.seq, row.state, row.reason)) shouldBe
      Seq((1L, Some("READY"), None), (2L, Some("KILLED"), Some("replaced by execution 7")))
    val label = ExecutionLogStore.label(uri).get
    label.beatEveryMs shouldBe StorageConfig.icebergTableCommitIntervalMs
    label.beatMs should be > startedAtMs
    // Its statistics and its console are where the stores' readers look for the execution's.
    val statistics = RuntimeStatisticsStore.read(statisticsUriOf(uri))
    statistics.map(_.copy(timeMs = 0)) shouldBe Seq(stored("scan", 0, RUNNING, out = 3))
    statistics.head.timeMs should be > startedAtMs
    ConsoleMessageStore.read(consoleUriOf(uri), Some("udf"), 0, 10)._1 shouldBe
      Seq(consoleRow(1, 1))
  }

  "ExecutionRecorder.none" should "take everything, write nothing and have nothing left to write" in {
    val recorder = ExecutionRecorder.none

    recorder.state("RUNNING")
    recorder.statistics(Map("scan" -> metrics(RUNNING, out = 3)))
    recorder.console("udf", message(1))
    recorder.state("FAILED", errors = Seq(error("boom")), reason = Some("why"))

    recorder.awaitIdle(0.seconds) shouldBe true
  }
}
