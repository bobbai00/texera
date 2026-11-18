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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  ExecutionLogEntry,
  ExecutionLogStore,
  NoSuchExecutionTableException,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore,
  VFSURIFactory
}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessage
import org.apache.texera.amber.engine.common.Utils.{maptoStatusCode, withLock}
import org.apache.texera.amber.engine.common.executionruntimestate.OperatorMetrics
import org.apache.texera.common.config.StorageConfig

import java.net.URI
import java.util.concurrent.locks.ReentrantLock
import java.util.concurrent.{Executors, RejectedExecutionException, ScheduledFuture, TimeUnit}
import scala.collection.mutable
import scala.concurrent.duration.FiniteDuration
import scala.util.control.NonFatal

/**
  * Keeps the record of one run in the lake, where it outlives the computing unit that runs it:
  * the changes of the run's state, in the execution's log ([[ExecutionLogStore]]); the
  * statistics of its operators ([[RuntimeStatisticsStore]]); and what its operators wrote to
  * their consoles ([[ConsoleMessageStore]]).
  *
  * No call waits for the lake. A change of state is written at once. Statistics and console
  * messages are kept in memory and stored at the recorder's next commit: on its timer, at the
  * next change of state, and at the run's end. What a run hands over after its end is dropped.
  */
trait ExecutionRecorder {

  /**
    * The run changed to `state`, one of [[ExecutionLogStore.States]], because of `errors` or
    * for `reason`. It is written at once, after every change told before it, and the caller does
    * not wait for the lake. A change to the state the run is in already, and any change after
    * the run has ended, is dropped.
    */
  def state(
      state: String,
      errors: Seq[WorkflowFatalError] = Nil,
      reason: Option[String] = None
  ): Unit

  /**
    * The newest numbers of the operators the engine reports, by logical operator. An operator
    * that `metrics` leaves out keeps the numbers it was last told with. A commit stores a row
    * for each operator whose numbers or state differ from the row last stored for it.
    */
  def statistics(metrics: Map[String, OperatorMetrics]): Unit

  /**
    * A console message of the logical operator `operatorId`, whole. The messages of a run are
    * numbered in the order they are told.
    */
  def console(operatorId: String, message: ConsoleMessage): Unit

  /**
    * Waits, at most `timeout`, until everything the recorder was handed is in the lake. For a
    * run that has ended that includes the tidy of its tables.
    *
    * @return whether the recorder has nothing left to write
    */
  def awaitIdle(timeout: FiniteDuration): Boolean
}

object ExecutionRecorder {

  /** How often the end of a run that could not be written yet is tried again. */
  val EndRetryMs = 5000L

  /** How many appends a recorder makes to one of its tables before it tidies the table. */
  val TidyEveryAppends = 50

  /** How many console messages come before they are stored without waiting for the timer. */
  val ConsoleBatchRows = 4096

  /**
    * How many console messages a recorder holds at most while the lake does not take them. The
    * oldest beyond that are dropped, and a row in their place says how many.
    */
  val ConsoleCapacity = 50000

  /** Whom the row is from that stands for console messages that were not stored. */
  val EngineSource = "(engine)"

  /**
    * Starts the record of the run of `context`'s execution: makes its log, its statistics table
    * and its console table, beats in the log, and commits every
    * `storage.iceberg.table.commit.interval-ms`.
    */
  def start(context: WorkflowContext): ExecutionRecorder =
    new LakeExecutionRecorder(
      ExecutionLogStore.logUri(context.workflowId, context.executionId, context.warehouse),
      RuntimeStatisticsStore.statisticsUri(
        context.workflowId,
        context.executionId,
        context.warehouse
      ),
      ConsoleMessageStore.consoleUri(context.workflowId, context.executionId, context.warehouse),
      StorageConfig.icebergTableCommitIntervalMs
    )

  /** Records nothing: for a run whose record nobody reads, as a spec's. */
  val none: ExecutionRecorder = new ExecutionRecorder {
    override def state(
        state: String,
        errors: Seq[WorkflowFatalError],
        reason: Option[String]
    ): Unit = ()

    override def statistics(metrics: Map[String, OperatorMetrics]): Unit = ()

    override def console(operatorId: String, message: ConsoleMessage): Unit = ()

    override def awaitIdle(timeout: FiniteDuration): Boolean = true
  }
}

/** What a recorder logs of one kind of write: that it failed, and that it is made again. */
private final case class WriteKind(failed: String, madeAgain: String)

/**
  * Writes a run's record to its three tables in the lake.
  *
  * No caller waits for the lake. What a caller hands over is kept under a lock, which gives a
  * change of state and a console message its place, and the recorder's one thread does every
  * write. So each table has one writer, which also tidies it, and no commit conflicts with
  * another.
  *
  *  - A change of state is appended to the log at once, with the label that repeats it; the
  *    changes that queued up meanwhile go oldest first in one commit.
  *  - Every `beatEveryMs` the thread ticks. A tick beats in the log first, which tells the
  *    log's readers that the run's unit is alive, so nothing later in the tick can hold that
  *    back; then it commits.
  *  - A commit writes the changes of state still queued; then a statistics row for each
  *    operator whose numbers or state differ from its last stored row, all with the time of the
  *    commit; then the console messages that wait. A change of state commits too, right after
  *    its row, and the console is stored without a tick whenever `consoleBatchRows` messages
  *    came since it was last stored.
  *  - A table that reached `tidyEveryAppends` appends since its last tidy is tidied; a beat is
  *    no append.
  *  - After the run's last row the ticks come every `endRetryMs`. Once everything is written,
  *    each table that was written to is tidied for its end, and the recorder stops.
  *
  * A write that fails leaves what it was to write in memory for the next commit, so a lake that
  * is out of reach delays the record and never reorders it. Nothing is given up while the unit
  * lives: a log left without its end would be read as the log of a run whose unit was lost.
  * Console messages alone are bounded: beyond `consoleCapacity` the oldest are dropped. A table
  * that is gone was dropped with its execution: it is not made again, and the recorder stops.
  *
  * @param logUri           the execution's log table
  * @param statisticsUri    the execution's statistics table
  * @param consoleUri       the execution's console table
  * @param beatEveryMs      how often the recorder ticks, which the label tells the log's readers
  * @param timed            whether the recorder ticks by itself; false for a caller that calls
  *                         [[tick]] instead, as a spec does
  * @param endRetryMs       how often it ticks while the end of the run waits to be written
  * @param tidyEveryAppends how many appends to a table come before its tidy
  * @param consoleBatchRows how many console messages, come since the console was last
  *                         stored, are stored without waiting for a tick
  * @param consoleCapacity  how many console messages wait for the lake at most
  * @param clock            the unit's clock, in epoch milliseconds
  * @param create           makes the log table, with its first beat and how often it beats
  * @param append           appends rows to the log table, with the label
  * @param beat             sets the beat of the log table
  * @param tidy             tidies the log table, for its end when asked to
  */
private[executionrecord] final class LakeExecutionRecorder(
    logUri: URI,
    statisticsUri: URI,
    consoleUri: URI,
    beatEveryMs: Long,
    timed: Boolean = true,
    endRetryMs: Long = ExecutionRecorder.EndRetryMs,
    tidyEveryAppends: Int = ExecutionRecorder.TidyEveryAppends,
    consoleBatchRows: Int = ExecutionRecorder.ConsoleBatchRows,
    consoleCapacity: Int = ExecutionRecorder.ConsoleCapacity,
    clock: () => Long = () => System.currentTimeMillis(),
    create: (URI, Long, Long) => Unit = ExecutionLogStore.create,
    append: (URI, Seq[ExecutionLogEntry], Long) => Unit = ExecutionLogStore.append,
    beat: (URI, Long) => Unit = ExecutionLogStore.beat,
    tidy: (URI, Boolean) => Unit = ExecutionLogStore.tidy,
    createStatistics: URI => Unit = RuntimeStatisticsStore.create,
    appendStatistics: (URI, Seq[RuntimeStatisticsRow]) => Unit = RuntimeStatisticsStore.append,
    tidyStatistics: (URI, Boolean) => Unit = RuntimeStatisticsStore.tidy,
    createConsole: URI => Unit = ConsoleMessageStore.create,
    appendConsole: (URI, Seq[ConsoleRow]) => Unit = ConsoleMessageStore.append,
    tidyConsole: (URI, Boolean) => Unit = ConsoleMessageStore.tidy
) extends ExecutionRecorder
    with LazyLogging {
  require(
    consoleBatchRows >= 1 && consoleCapacity >= 1,
    s"a recorder stores console messages $consoleBatchRows at a time and holds " +
      s"$consoleCapacity: each must be 1 at least"
  )

  private val executionId = VFSURIFactory.decodeURI(logUri).executionId.id

  private implicit val lock: ReentrantLock = new ReentrantLock()
  private val written = lock.newCondition()

  // Guarded by the lock: what the run handed over and the lake does not hold yet.
  // The changes of state not yet written, oldest first, and what queues the next one.
  private val unwritten = mutable.ArrayBuffer.empty[ExecutionLogEntry]
  private var lastSeq = 0L
  private var lastState: Option[String] = None
  // The newest numbers of every operator, how often they were told, and the telling the
  // statistics table is up to date with.
  private var newestMetrics = Map.empty[String, OperatorMetrics]
  private var metricsTold = 0L
  private var metricsStored = 0L
  // The console messages not yet stored, oldest first: their seq rises by one from row to row.
  private val consoleWaiting = mutable.ArrayDeque.empty[ConsoleRow]
  private var consoleSeq = 0L
  private var consoleSinceCommit = 0
  // Nothing is taken once the run's end is queued, or once the recorder has stopped.
  private var closed = false
  private var stopped = false

  // What follows is used on the recorder's thread alone.

  /** One of the recorder's tables, with what its thread knows of it. */
  private final class RecordTable(
      val kind: WriteKind,
      make: () => Unit,
      tidyTable: Boolean => Unit
  ) {
    private var made = false
    private var everAppended = false
    private var appendsSinceTidy = 0

    /** Whether the table is there to be written: one that could not be made is made now. */
    def ready(): Boolean = {
      if (!made) made = attempt(kind)(make())
      made
    }

    /** Makes one append to the table, and says whether it was made. */
    def appending(write: => Unit): Boolean = {
      val appended = ready() && attempt(kind)(write)
      if (appended) {
        everAppended = true
        appendsSinceTidy += 1
      }
      appended
    }

    def tidyIfDue(): Unit =
      if (appendsSinceTidy >= tidyEveryAppends && attempt(kind)(tidyTable(false))) {
        appendsSinceTidy = 0
      }

    /** A table nothing was appended to has nothing to tidy. */
    def tidyForEnd(): Unit = if (everAppended) attempt(kind)(tidyTable(true))
  }

  // The kinds of write, each with what is logged when it starts to fail and when it is made
  // again. A beat is apart from a write of rows: it reaches the catalog alone, so it goes on
  // while the object store is out of reach.
  private def rowsOf(table: String, is: String): WriteKind =
    WriteKind(
      s"A write to the $table of execution $executionId failed; what it left unwritten is " +
        "tried again on every tick.",
      s"The $table of execution $executionId $is written again."
    )
  private val Beat = WriteKind(
    s"A beat of execution $executionId failed; the next tick beats again.",
    s"Execution $executionId beats again."
  )
  private val failing = mutable.Set.empty[WriteKind]

  private val logTable = new RecordTable(
    rowsOf("log", "is"),
    () => create(logUri, clock(), beatEveryMs),
    tidy(logUri, _)
  )
  private val statisticsTable = new RecordTable(
    rowsOf("statistics", "are"),
    () => createStatistics(statisticsUri),
    tidyStatistics(statisticsUri, _)
  )
  private val consoleTable = new RecordTable(
    rowsOf("console output", "is"),
    () => createConsole(consoleUri),
    tidyConsole(consoleUri, _)
  )
  private val tables = Seq(logTable, statisticsTable, consoleTable)

  // The row last stored for each operator, without its time: an operator gets a new row when
  // its newest numbers make another.
  private val storedStatistics = mutable.Map.empty[String, RuntimeStatisticsRow]
  // The seq of the newest console row the table holds, or that a row in it stands for.
  private var consoleStoredSeq = 0L
  private var endWritten = false
  private var halted = false
  private var timer: Option[ScheduledFuture[_]] = None

  private val thread = Executors.newSingleThreadScheduledExecutor { task =>
    val thread = new Thread(task, s"execution-record-$executionId")
    thread.setDaemon(true)
    thread
  }

  thread.execute { () =>
    tables.foreach(_.ready())
    tickEvery(beatEveryMs)
  }

  override def state(
      state: String,
      errors: Seq[WorkflowFatalError],
      reason: Option[String]
  ): Unit =
    withLock {
      if (closed) {
        logger.warn(
          s"The change of execution $executionId to $state is not logged: its log has ended."
        )
      } else if (!lastState.contains(state)) {
        val ending = ExecutionLogStore.EndStates.contains(state)
        lastSeq += 1
        lastState = Some(state)
        unwritten += ExecutionLogEntry.state(lastSeq, clock(), state, reason, errors)
        if (ending) closed = true
        thread.execute { () =>
          guarded(commit())
          // The end of a run that could not be written is tried again soon, not a beat later.
          if (ending) tickEvery(endRetryMs)
        }
      }
    }

  override def statistics(metrics: Map[String, OperatorMetrics]): Unit =
    withLock {
      if (!closed) {
        newestMetrics ++= metrics
        metricsTold += 1
      }
    }

  override def console(operatorId: String, message: ConsoleMessage): Unit =
    withLock {
      if (!closed) {
        consoleSeq += 1
        consoleWaiting += ConsoleRow(
          consoleSeq,
          message.timestamp.seconds * 1000 + message.timestamp.nanos / 1000000,
          operatorId,
          message.workerId,
          message.msgType.name,
          message.source,
          message.title,
          message.message
        )
        // The lake is not taking them: the newest are worth more than the oldest.
        if (consoleWaiting.size > consoleCapacity) consoleWaiting.removeHead()
        consoleSinceCommit += 1
        // Asked once for every batch that came since a commit, so a lake that is out of reach
        // is not tried again for each message.
        if (consoleSinceCommit == consoleBatchRows) {
          thread.execute { () =>
            guarded {
              storeConsole()
              consoleTable.tidyIfDue()
            }
          }
        }
      }
    }

  override def awaitIdle(timeout: FiniteDuration): Boolean =
    withLock {
      var left = timeout.toNanos
      while (!idle && left > 0) left = written.awaitNanos(left)
      idle
    }

  // Under the lock. A run whose end is queued is done once its tables are tidied, which is
  // when the recorder stops.
  private def idle: Boolean = stopped || (!closed && nothingWaits)

  private def nothingWaits: Boolean =
    unwritten.isEmpty && consoleWaiting.isEmpty && metricsStored == metricsTold

  /** Runs one tick now, on the recorder's thread, and returns once it is done. */
  private[executionrecord] def tick(): Unit =
    try thread.submit((() => onTick()): Runnable).get()
    catch {
      // The recorder has stopped: there is nothing left to tick for.
      case _: RejectedExecutionException =>
    }

  // What follows runs on the recorder's thread.

  private def tickEvery(ms: Long): Unit =
    if (timed && !thread.isShutdown) {
      timer.foreach(_.cancel(false))
      timer = Some(thread.scheduleWithFixedDelay(() => onTick(), ms, ms, TimeUnit.MILLISECONDS))
    }

  /** Beats, and commits. */
  private def onTick(): Unit =
    guarded {
      tables.foreach(_.ready())
      // A run whose end is in its log is over to every reader: it beats no more.
      if (!endWritten && logTable.ready()) attempt(Beat)(beat(logUri, clock()))
      commit()
    }

  /**
    * Runs a step of the recorder's thread, which never throws, whatever a write does: a
    * scheduled task that throws is not run again, and a run whose beat stops is taken for lost.
    */
  private def guarded(step: => Unit): Unit =
    try step
    catch {
      case failure: Throwable =>
        logger.error(s"A step of the record of execution $executionId failed.", failure)
    }

  /**
    * Writes what waits: the changes of state, then the statistics, then the console messages.
    * Then it tidies a table that is due; or, once the run's last row and everything else is
    * written, tidies the tables for their end and stops.
    */
  private def commit(): Unit = {
    writeLog()
    storeStatistics()
    storeConsole()
    if (!endWritten) tables.foreach(_.tidyIfDue())
    else if (withLock(nothingWaits)) {
      tables.foreach(_.tidyForEnd())
      stop()
    }
  }

  /** Appends the queued changes of state in one commit. */
  private def writeLog(): Unit = {
    val rows = withLock(unwritten.toList)
    if (rows.nonEmpty && logTable.appending(append(logUri, rows, clock()))) {
      if (rows.last.state.exists(ExecutionLogStore.EndStates.contains)) endWritten = true
      withLock {
        unwritten.dropInPlace(rows.size)
        written.signalAll()
      }
    }
  }

  /**
    * Appends a row for each operator whose newest numbers differ from its last stored row, all
    * with the time of this commit.
    */
  private def storeStatistics(): Unit = {
    val (told, metrics, upToDate) =
      withLock((metricsTold, newestMetrics, metricsStored == metricsTold))
    if (!upToDate) {
      val changed = metrics.toSeq
        .sortBy { case (operatorId, _) => operatorId }
        .map { case (operatorId, operator) => statisticsRow(operatorId, operator) }
        .filterNot(row => storedStatistics.get(row.operatorId).contains(row))
      val now = clock()
      if (
        changed.isEmpty || statisticsTable.appending(
          appendStatistics(statisticsUri, changed.map(_.copy(timeMs = now)))
        )
      ) {
        changed.foreach(row => storedStatistics(row.operatorId) = row)
        withLock {
          metricsStored = told
          written.signalAll()
        }
      }
    }
  }

  /** The row of an operator's numbers, without a time: the totals over its ports. */
  private def statisticsRow(operatorId: String, metrics: OperatorMetrics): RuntimeStatisticsRow = {
    val statistics = metrics.operatorStatistics
    RuntimeStatisticsRow(
      operatorId = operatorId,
      timeMs = 0L,
      inputTupleCnt = statistics.inputMetrics.map(_.tupleMetrics.count).sum,
      inputTupleSize = statistics.inputMetrics.map(_.tupleMetrics.size).sum,
      outputTupleCnt = statistics.outputMetrics.map(_.tupleMetrics.count).sum,
      outputTupleSize = statistics.outputMetrics.map(_.tupleMetrics.size).sum,
      dataProcessingTime = statistics.dataProcessingTime,
      controlProcessingTime = statistics.controlProcessingTime,
      idleTime = statistics.idleTime,
      numWorkers = statistics.numWorkers,
      status = maptoStatusCode(metrics.operatorState).toInt
    )
  }

  /**
    * Appends the console messages that wait, in one commit. Where messages were dropped since
    * the last row stored, a row says how many, with the seq of the last of them.
    */
  private def storeConsole(): Unit = {
    val rows = withLock {
      consoleSinceCommit = 0
      consoleWaiting.toList
    }
    if (rows.nonEmpty) {
      val dropped = rows.head.seq - 1 - consoleStoredSeq
      val batch =
        if (dropped > 0)
          ConsoleRow(
            seq = rows.head.seq - 1,
            timeMs = rows.head.timeMs,
            operatorId = "",
            workerId = "",
            msgType = "ERROR",
            source = ExecutionRecorder.EngineSource,
            title = s"$dropped console messages were not stored",
            message = ""
          ) :: rows
        else rows
      if (consoleTable.appending(appendConsole(consoleUri, batch))) {
        consoleStoredSeq = rows.last.seq
        withLock {
          // Some of them may have been dropped meanwhile, to make room for newer ones.
          while (consoleWaiting.headOption.exists(_.seq <= consoleStoredSeq)) {
            consoleWaiting.removeHead()
          }
          written.signalAll()
        }
      }
    }
  }

  /**
    * Makes one write to the lake, and says whether it was made. One that fails is reported once
    * for as long as writes of its kind keep failing, and what it left in memory is written by
    * a later commit. A recorder that has stopped writes nothing.
    */
  private def attempt(kind: WriteKind)(write: => Unit): Boolean =
    if (halted) false
    else
      try {
        write
        if (failing.remove(kind)) logger.info(kind.madeAgain)
        true
      } catch {
        case _: NoSuchExecutionTableException =>
          logger.warn(
            s"A table of the record of execution $executionId is gone, as a deleted " +
              "execution's is: the record is written no more."
          )
          stop()
          false
        case NonFatal(failure) =>
          if (failing.add(kind)) logger.warn(kind.failed, failure)
          false
      }

  /** Ends the recorder: what still waits is dropped, and its thread is let go of. */
  private def stop(): Unit = {
    halted = true
    withLock {
      closed = true
      stopped = true
      unwritten.clear()
      consoleWaiting.clear()
      written.signalAll()
    }
    timer.foreach(_.cancel(false))
    thread.shutdown()
  }
}
