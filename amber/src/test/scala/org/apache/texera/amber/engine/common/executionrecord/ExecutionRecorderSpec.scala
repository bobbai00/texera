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
import org.apache.texera.amber.core.storage.{
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  IcebergCatalogInstance,
  NoSuchExecutionTableException
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.common.config.StorageConfig
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}
import org.slf4j.LoggerFactory

import java.net.URI
import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger, AtomicLong}
import java.util.concurrent.{ConcurrentLinkedQueue, CountDownLatch, Executors, TimeUnit}
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Specs for the recorder that writes a run's log. Its logs are real tables, of executions of a
  * workflow of this suite's own, in the catalog the build's tests use, and are dropped after the
  * suite. Unless a case says otherwise the recorder ticks only when the case asks it to, on a
  * clock the case sets, and the store it writes to is the lake's, at most wrapped to count, slow
  * or fail a call.
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
    madeLogs.asScala.foreach(uri => Try(ExecutionLogStore.drop(uri)))
    super.afterAll()
  }

  /** The log of an execution no other case names. */
  private def freshLog(): URI = {
    val uri = ExecutionLogStore.logUri(
      workflowId,
      ExecutionIdentity(nextExecutionId.getAndIncrement()),
      None
    )
    madeLogs.add(uri)
    uri
  }

  /** The execution whose log is at `uri`, a URI of `/wid/<wid>/eid/<eid>/executionlog`. */
  private def executionIdOf(uri: URI): Long = uri.getPath.split("/")(4).toLong

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
      create: (URI, Long, Long) => Unit = ExecutionLogStore.create,
      append: (URI, Seq[ExecutionLogEntry], Long) => Unit = ExecutionLogStore.append,
      beat: (URI, Long) => Unit = ExecutionLogStore.beat,
      tidy: (URI, Boolean) => Unit = ExecutionLogStore.tidy
  ) {
    val clock = new AtomicLong(startedAtMs)

    /** The seq of the rows of each append that was made, and the thread of every write. */
    val appended = new ConcurrentLinkedQueue[Seq[Long]]()
    val writers = new ConcurrentLinkedQueue[Thread]()
    val beats = new AtomicInteger()

    private def onWriter[T](write: => T): T = {
      writers.add(Thread.currentThread())
      write
    }

    val recorder = new LakeExecutionRecorder(
      uri,
      beatEveryMs,
      timed,
      endRetryMs,
      () => clock.get(),
      (uri, nowMs, every) => onWriter(create(uri, nowMs, every)),
      (uri, rows, nowMs) =>
        onWriter {
          append(uri, rows, nowMs)
          appended.add(rows.map(_.seq))
        },
      (uri, nowMs) =>
        onWriter {
          beat(uri, nowMs)
          beats.incrementAndGet()
        },
      (uri, atEnd) => onWriter(tidy(uri, atEnd))
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

    def table: Table = {
      val name = uri.getPath.stripPrefix("/").replace("/", "_")
      IcebergCatalogInstance
        .getInstance()
        .loadTable(TableIdentifier.of(StorageConfig.icebergTableExecutionLogNamespace, name))
    }

    def snapshotCount: Int = table.snapshots().asScala.size

    def dataFileCount: Int = table.currentSnapshot().summary().get("total-data-files").toInt

    /** Whether the recorder's thread is still there. */
    def threadAlive: Boolean = writers.asScala.exists(_.isAlive)
  }

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

  it should "write on the next tick what a lake out of reach left unwritten, and report the outage once" in {
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
    // Six writes failed and two were made: the outage was reported once, and its end once.
    outage.calls.get() shouldBe 8
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

  it should "be given up when it could not be written for two minutes, and the recorder stop" in {
    val outage = new Outage(startsOn = false)
    val f = new Fixture(
      append = (uri, rows, nowMs) => outage.unless(ExecutionLogStore.append(uri, rows, nowMs))
    )
    f.told("RUNNING")
    outage.on.set(true)
    outage.calls.set(0)
    f.clock.addAndGet(1000)
    f.recorder.state("COMPLETED")

    // Tried on every tick until two minutes have passed since the run ended.
    f.clock.addAndGet(ExecutionRecorder.EndPatienceMs - 1)
    f.recorder.tick()
    f.recorder.awaitIdle(100.millis) shouldBe false
    outage.calls.get() shouldBe 2
    f.threadAlive shouldBe true

    f.clock.addAndGet(1)
    f.recorder.tick()

    // Left without its ending: nothing more is written, and the beat stops.
    f.recorder.awaitIdle(1.second) shouldBe true
    eventually(f.threadAlive shouldBe false)
    outage.on.set(false)
    f.recorder.tick()
    outage.calls.get() shouldBe 3
    f.rows shouldBe Seq((1L, "RUNNING", None))
    f.label.ended shouldBe false
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
  // the two recorders a run is given
  // ---------------------------------------------------------------------------

  "ExecutionRecorder.start" should "record the run of a context's execution in its log, beating as configured" in {
    val uri = freshLog()
    val eid = uri.getPath.split("/")(4).toLong
    val recorder = ExecutionRecorder.start(
      new WorkflowContext(workflowId = workflowId, executionId = ExecutionIdentity(eid))
    )

    recorder.state("READY")
    recorder.state("KILLED", reason = Some("replaced by execution 7"))

    recorder.awaitIdle(30.seconds) shouldBe true
    ExecutionLogStore.read(uri).map(row => (row.seq, row.state, row.reason)) shouldBe
      Seq((1L, Some("READY"), None), (2L, Some("KILLED"), Some("replaced by execution 7")))
    val label = ExecutionLogStore.label(uri).get
    label.beatEveryMs shouldBe StorageConfig.icebergTableCommitIntervalMs
    label.beatMs should be > startedAtMs
  }

  "ExecutionRecorder.none" should "take everything, write nothing and have nothing left to write" in {
    val recorder = ExecutionRecorder.none

    recorder.state("RUNNING")
    recorder.state("FAILED", errors = Seq(error("boom")), reason = Some("why"))

    recorder.awaitIdle(0.seconds) shouldBe true
  }
}
