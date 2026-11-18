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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{
  ExecutionAlreadyStartedException,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  ExecutionPlanStore,
  ExecutionTables,
  NoStoredPlanException
}
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.web.service.WorkflowEmailNotifier
import org.apache.texera.web.service.WorkflowEmailNotifier.{Corrected, Notification}
import org.apache.texera.web.service.execution.ExecutionClosing.{Ending, Read}

import java.net.URI
import java.util.concurrent.{Executor, Executors}
import scala.util.control.NonFatal

object ExecutionCloser {

  /**
    * The one thread the service sends the emails about closed executions on, so a mail server
    * that is slow holds up no close. A daemon: an email not yet sent does not keep the service
    * from stopping.
    */
  private lazy val emailThread: Executor =
    Executors.newSingleThreadExecutor((task: Runnable) => {
      val thread = new Thread(task, "execution-closing-email")
      thread.setDaemon(true)
      thread
    })

  /**
    * The bytes of the tables `execution` keeps in the lake ([[ExecutionTables]]). A table that is
    * not there, such as that of a port the run did not store, counts nothing.
    */
  def storedBytesOf(execution: ExecutionRecord): Long = {
    val own =
      ExecutionTables.ownTables(execution.workflowId, execution.executionId, execution.warehouse)
    (own ++ ExecutionTables.portTables(execution.planUri)).map(ExecutionTables.storedBytes).sum
  }
}

/**
  * Closes executions: what the closing job does about one once [[ExecutionClosing]] decided it.
  *
  * Whoever closes an execution writes its closing record with one conditional UPDATE
  * ([[ExecutionRecords.close]]), so of several that try, one does; that one then emails the
  * execution's user, if the execution asked for that, records what the execution's tables hold
  * and logs a line. The time an execution ended at comes from its unit's clock, so it is kept
  * between the execution's creation and now.
  *
  * An execution is emailed about once, after the UPDATE that closed it and by the replica
  * that made it: a service that stops in between sends none, where the other order could send
  * two. No email is sent about an execution that no unit ever started, since nothing ran. An
  * execution whose verdict is replaced by the ending in its log ([[reviseIfEnded]]) is emailed
  * about once more, since the first email said it had failed. An email that cannot be sent is
  * logged, and changes nothing of the close.
  *
  * A lake call that throws is thrown on, never taken for "no log", "no plan" or "no ending":
  * the job logs it and looks at the execution again on its next tick. The one exception is the
  * measuring of a closed execution's tables, whose failure is logged here, since the execution
  * is closed by then.
  *
  * @param now         the Dashboard service's clock, in epoch milliseconds
  * @param emailThread runs each send, off the thread that closes
  */
class ExecutionCloser(
    label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
    rows: URI => Seq[ExecutionLogEntry] = ExecutionLogStore.read,
    isStarted: URI => Boolean = ExecutionPlanStore.isStarted,
    claimStart: URI => Unit = ExecutionPlanStore.claimStart,
    storedBytes: ExecutionRecord => Long = ExecutionCloser.storedBytesOf,
    now: () => Long = () => System.currentTimeMillis(),
    emails: WorkflowEmailNotifier = new WorkflowEmailNotifier(),
    emailThread: Executor = ExecutionCloser.emailThread
) extends LazyLogging {

  /** What the lake holds of `execution`, for [[ExecutionClosing.decide]]. */
  def read(execution: ExecutionRecord): Read =
    label(execution.logUri) match {
      case Some(found) => Read.Log(found)
      case None =>
        val planStarted =
          try isStarted(execution.planUri)
          catch { case _: NoStoredPlanException => false }
        Read.NoLog(planStarted)
    }

  /**
    * Closes `execution` with `ending`, unless it is closed already.
    *
    * @param fromLog      whether `ending` is one its log holds
    * @param neverStarted no unit ever started it (see [[ExecutionRecords.close]])
    * @return whether this call closed it
    */
  def close(
      execution: ExecutionRecord,
      ending: Ending,
      fromLog: Boolean,
      neverStarted: Boolean = false
  ): Boolean = closeRow(execution, ending, fromLog, neverStarted, measured = true)

  /** Closes `execution` with the ending its log's label shows, if it shows one. */
  def closeIfEnded(execution: ExecutionRecord): Boolean =
    label(execution.logUri)
      .flatMap(ExecutionClosing.endingIn)
      .exists(close(execution, _, fromLog = true))

  /**
    * Takes the one start of `execution`, which no unit started in time, and closes it as never
    * started: nothing can start it afterwards. An execution with no plan table cannot be
    * started either. One whose start a unit claimed first is left open.
    */
  def claimThenClose(execution: ExecutionRecord): Boolean = {
    val unstartable =
      try {
        claimStart(execution.planUri)
        true
      } catch {
        case _: NoStoredPlanException            => true
        case _: ExecutionAlreadyStartedException => false
      }
    unstartable && close(
      execution,
      Ending(WorkflowExecutionStatus.Failed, Some(ExecutionClosing.NeverStarted), now()),
      fromLog = false,
      neverStarted = true
    )
  }

  /**
    * Closes `execution`, whose unit is gone, as failed for `reason`, as of the unit's last
    * sign of life, unless the rows of its log hold an ending: a unit can write its last row and
    * be gone before the label is read. Its start is taken first if no unit took it, so nothing
    * starts an execution that is recorded as over.
    *
    * @param label the label this tick read; None when the execution has no log
    */
  def loseUnlessEnded(
      execution: ExecutionRecord,
      reason: String,
      label: Option[ExecutionLabel]
  ): Boolean =
    rows(execution.logUri).findLast(_.state.exists(ExecutionLogStore.EndStates.contains)) match {
      case Some(row) =>
        close(
          execution,
          Ending(ExecutionStatus.of(row.state.get), row.reason, row.timeMs),
          fromLog = true
        )
      case None =>
        // A log is made by the unit that claimed the start.
        if (label.isEmpty) {
          try claimStart(execution.planUri)
          catch { case _: ExecutionAlreadyStartedException | _: NoStoredPlanException => () }
        }
        close(
          execution,
          Ending(
            WorkflowExecutionStatus.Failed,
            Some(reason),
            label.map(_.beatMs).getOrElse(now())
          ),
          fromLog = false
        )
    }

  /**
    * Closes `execution`, whose warehouse cannot be reached
    * ([[ExecutionClosing.warehouseUnavailable]]), as failed. Nothing of it is read or measured.
    */
  def closeUnavailable(execution: ExecutionRecord): Boolean =
    closeRow(
      execution,
      Ending(WorkflowExecutionStatus.Failed, Some(ExecutionClosing.WarehouseUnavailable), now()),
      fromLog = false,
      neverStarted = false,
      measured = false
    )

  /**
    * Replaces the verdict `execution` was closed by with the ending its log's label shows, if
    * it shows one: the unit was cut off from the lake, not gone, and reported once it was back.
    * Its tables are measured again, since the run went on writing.
    *
    * @return whether this call replaced the verdict
    */
  def reviseIfEnded(execution: ExecutionRecord): Boolean =
    label(execution.logUri).flatMap(ExecutionClosing.endingIn).exists { ending =>
      val endedAtMs =
        ExecutionClosing.endedAtWithin(ending.endedAtMs, execution.startingTimeMs, now())
      val revised =
        ExecutionRecords.revise(execution.eid, ending.outcome, ending.reason, endedAtMs)
      if (revised) {
        logger.info(
          s"Execution ${execution.eid} of workflow ${execution.wid}, closed as " +
            s"${execution.closing.fold("open")(was => describe(was.outcome, was.reason))}, " +
            s"ended as ${describe(ending.outcome, ending.reason)} by its log, which is " +
            "recorded in the verdict's place."
        )
        email(
          execution,
          ending.copy(endedAtMs = endedAtMs),
          corrects = execution.closing.map(was => Corrected(was.outcome, was.reason))
        )
        measure(execution)
      }
      revised
    }

  private def closeRow(
      execution: ExecutionRecord,
      ending: Ending,
      fromLog: Boolean,
      neverStarted: Boolean,
      measured: Boolean
  ): Boolean = {
    val endedAtMs =
      ExecutionClosing.endedAtWithin(ending.endedAtMs, execution.startingTimeMs, now())
    val closed = ExecutionRecords.close(
      execution.eid,
      ending.outcome,
      ending.reason,
      endedAtMs,
      fromLog,
      neverStarted
    )
    if (closed) {
      logger.info(
        s"Execution ${execution.eid} of workflow ${execution.wid} is closed as " +
          describe(ending.outcome, ending.reason) + (if (fromLog) ", as its log says." else ".")
      )
      if (!neverStarted) email(execution, ending.copy(endedAtMs = endedAtMs), corrects = None)
      if (measured) measure(execution)
    }
    closed
  }

  /**
    * Hands the email that `execution` ended with `ending` to the email thread, if the execution
    * asked for one. A notification that cannot be read and an email that cannot be sent are
    * logged.
    *
    * @param corrects the verdict an earlier email reported, which `ending` replaced
    */
  private def email(
      execution: ExecutionRecord,
      ending: Ending,
      corrects: Option[Corrected]
  ): Unit =
    execution.notification.foreach { notification =>
      val send: Runnable = () =>
        try {
          emails.send(
            Notification.fromJson(notification),
            execution.wid,
            ending.outcome,
            ending.reason,
            ending.endedAtMs,
            corrects
          )
        } catch {
          case NonFatal(failure) =>
            logger.warn(
              s"The email that execution ${execution.eid} of workflow ${execution.wid} ended " +
                s"could not be sent: $failure"
            )
        }
      try emailThread.execute(send)
      catch {
        case NonFatal(refused) =>
          logger.warn(
            s"The email that execution ${execution.eid} of workflow ${execution.wid} ended " +
              s"was not handed over to be sent: $refused"
          )
      }
    }

  private def measure(execution: ExecutionRecord): Unit =
    try ExecutionRecords.setStoredBytes(execution.eid, storedBytes(execution))
    catch {
      case NonFatal(failure) =>
        logger.warn(
          s"What execution ${execution.eid} holds in the lake could not be measured, so its " +
            "stored bytes are not recorded.",
          failure
        )
    }

  private def describe(outcome: Short, reason: Option[String]): String =
    ExecutionClosing.nameOf(outcome) + reason.fold("")(why => s" ($why)")
}
