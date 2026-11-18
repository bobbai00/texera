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
  ExecutionLogEntry,
  ExecutionLogStore,
  NoSuchExecutionTableException,
  VFSURIFactory
}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessage
import org.apache.texera.amber.engine.common.Utils.withLock
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
  * the changes of the run's state, in the execution's log ([[ExecutionLogStore]]).
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

  /** The newest numbers of every operator. Not recorded: the statistics service stores them. */
  def statistics(metrics: Map[String, OperatorMetrics]): Unit = ()

  /** A console message of operator `operatorId`. Not recorded: the console service stores it. */
  def console(operatorId: String, message: ConsoleMessage): Unit = ()

  /**
    * Waits, at most `timeout`, until the recorder has nothing left to write.
    *
    * @return whether it has nothing left to write
    */
  def awaitIdle(timeout: FiniteDuration): Boolean
}

object ExecutionRecorder {

  /** How often the end of a run that could not be written yet is tried again. */
  val EndRetryMs = 5000L

  /** Starts the record of the run of `context`'s execution: makes its log, and beats in it. */
  def start(context: WorkflowContext): ExecutionRecorder =
    new LakeExecutionRecorder(
      ExecutionLogStore.logUri(context.workflowId, context.executionId, context.warehouse),
      StorageConfig.icebergTableCommitIntervalMs
    )

  /** Records nothing: for a run whose record nobody reads, as a spec's. */
  val none: ExecutionRecorder = new ExecutionRecorder {
    override def state(
        state: String,
        errors: Seq[WorkflowFatalError],
        reason: Option[String]
    ): Unit = ()

    override def awaitIdle(timeout: FiniteDuration): Boolean = true
  }
}

/** What a recorder logs of one kind of write: that it failed, and that it is made again. */
private final case class WriteKind(failed: String, madeAgain: String)

/**
  * Writes a run's log: a row for each change of state, with the label that repeats the newest
  * one, and a beat on every tick, which tells the log's readers that the run's unit is alive.
  *
  * No caller waits for the lake. A change of state is queued under a lock, which gives it its
  * place in the log, and the recorder's one thread does every write: it makes the table, appends
  * the queued rows oldest first, beats, and after the run's last row tidies the table and ends.
  * A write that fails leaves its rows queued for the next tick, so a lake that is out of reach
  * delays the log and never reorders it. While the end of the run waits to be written the ticks
  * come every `endRetryMs`, for as long as the unit lives: a log left without its end would be
  * read as the log of a run whose unit was lost. A table that is gone was dropped with its
  * execution: it is not made again, and the recorder stops.
  *
  * @param logUri      the execution's log table
  * @param beatEveryMs how often the recorder ticks, which the label tells the log's readers
  * @param timed       whether the recorder ticks by itself; false for a caller that calls
  *                    [[tick]] instead, as a spec does
  * @param endRetryMs  how often it ticks while the end of the run waits to be written
  * @param clock       the unit's clock, in epoch milliseconds
  * @param create      makes the log table, with its first beat and how often it beats
  * @param append      appends rows to the log table, with the label
  * @param beat        sets the beat of the log table
  * @param tidy        tidies the log table, for its end when asked to
  */
private[executionrecord] final class LakeExecutionRecorder(
    logUri: URI,
    beatEveryMs: Long,
    timed: Boolean = true,
    endRetryMs: Long = ExecutionRecorder.EndRetryMs,
    clock: () => Long = () => System.currentTimeMillis(),
    create: (URI, Long, Long) => Unit = ExecutionLogStore.create,
    append: (URI, Seq[ExecutionLogEntry], Long) => Unit = ExecutionLogStore.append,
    beat: (URI, Long) => Unit = ExecutionLogStore.beat,
    tidy: (URI, Boolean) => Unit = ExecutionLogStore.tidy
) extends ExecutionRecorder
    with LazyLogging {

  private val executionId = VFSURIFactory.decodeURI(logUri).executionId.id

  private implicit val lock: ReentrantLock = new ReentrantLock()
  private val written = lock.newCondition()

  // Guarded by the lock: the rows not yet written, oldest first, and what queues the next one.
  private val unwritten = mutable.ArrayBuffer.empty[ExecutionLogEntry]
  private var lastSeq = 0L
  private var lastState: Option[String] = None
  // No row is queued once the run's end is, or once the recorder has stopped.
  private var closed = false

  // Used on the recorder's thread alone.
  private var tableMade = false
  private var timer: Option[ScheduledFuture[_]] = None

  // The kinds of write, each with what is logged when it starts to fail and when it is made
  // again. A beat is apart from a write of rows: it reaches the catalog alone, so it goes on
  // while the object store is out of reach.
  private val LogWrite = WriteKind(
    s"A write to the log of execution $executionId failed; what it left unwritten is tried " +
      "again on every tick.",
    s"The log of execution $executionId is written again."
  )
  private val Beat = WriteKind(
    s"A beat of execution $executionId failed; the next tick beats again.",
    s"Execution $executionId beats again."
  )
  private val failing = mutable.Set.empty[WriteKind]

  private val thread = Executors.newSingleThreadScheduledExecutor { task =>
    val thread = new Thread(task, s"execution-record-$executionId")
    thread.setDaemon(true)
    thread
  }

  thread.execute { () =>
    makeTable()
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
        val now = clock()
        val ending = ExecutionLogStore.EndStates.contains(state)
        lastSeq += 1
        lastState = Some(state)
        unwritten += ExecutionLogEntry.state(lastSeq, now, state, reason, errors)
        if (ending) closed = true
        thread.execute { () =>
          write()
          // The end of a run that could not be written is tried again soon, not a beat later.
          if (ending) tickEvery(endRetryMs)
        }
      }
    }

  override def awaitIdle(timeout: FiniteDuration): Boolean =
    withLock {
      var left = timeout.toNanos
      while (unwritten.nonEmpty && left > 0) left = written.awaitNanos(left)
      unwritten.isEmpty
    }

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

  /**
    * Beats, and writes the rows an earlier write left queued. It never throws: a scheduled task
    * that throws is not run again, and a run whose beat stops is taken for lost.
    */
  private def onTick(): Unit =
    try {
      if (makeTable()) {
        attempt(Beat)(beat(logUri, clock()))
        write()
      }
    } catch {
      case failure: Throwable =>
        logger.error(s"A tick of the log of execution $executionId failed.", failure)
    }

  private def makeTable(): Boolean = {
    if (!tableMade) tableMade = attempt(LogWrite)(create(logUri, clock(), beatEveryMs))
    tableMade
  }

  /** Appends the queued rows in one commit; after the run's last row, tidies the log and stops. */
  private def write(): Unit = {
    val rows = withLock(unwritten.toList)
    if (rows.nonEmpty && makeTable() && attempt(LogWrite)(append(logUri, rows, clock()))) {
      if (rows.last.state.exists(ExecutionLogStore.EndStates.contains)) {
        attempt(LogWrite)(tidy(logUri, true))
        stop()
      } else {
        withLock {
          unwritten.dropInPlace(rows.size)
          written.signalAll()
        }
      }
    }
  }

  /**
    * Makes one write to the lake, and says whether it was made. One that fails is reported once
    * for as long as writes of its kind keep failing, and what it left queued is written on a
    * later tick.
    */
  private def attempt(kind: WriteKind)(write: => Unit): Boolean =
    try {
      write
      if (failing.remove(kind)) logger.info(kind.madeAgain)
      true
    } catch {
      case _: NoSuchExecutionTableException =>
        logger.warn(
          s"The log of execution $executionId is gone, as a deleted execution's is: it is " +
            "written no more."
        )
        stop()
        false
      case NonFatal(failure) =>
        if (failing.add(kind)) logger.warn(kind.failed, failure)
        false
    }

  /** Ends the recorder: what is still queued is dropped, and its thread is let go of. */
  private def stop(): Unit = {
    withLock {
      closed = true
      unwritten.clear()
      written.signalAll()
    }
    timer.foreach(_.cancel(false))
    thread.shutdown()
  }
}
