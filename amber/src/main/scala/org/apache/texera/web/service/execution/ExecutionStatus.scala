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
import org.apache.texera.amber.core.storage.{ExecutionLabel, ExecutionLogStore}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.WorkflowExecutionStatus

import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{
  Callable,
  CancellationException,
  ExecutionException,
  ExecutorService,
  LinkedBlockingQueue,
  ThreadPoolExecutor,
  TimeUnit
}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._

/** The status code the API answers for what an execution's log says of it. */
object ExecutionStatus {

  /**
    * The code of `state`, a state a log records: the code a computing unit records for the
    * engine's state of that name.
    *
    * @throws IllegalArgumentException if a log records no such state
    */
  def of(state: String): Short =
    Option
      .when(ExecutionLogStore.States.contains(state))(state)
      .flatMap(WorkflowAggregatedState.fromName)
      .map(maptoStatusCode(_).toShort)
      .getOrElse(
        throw new IllegalArgumentException(s"an execution's log records no state '$state'")
      )

  /**
    * The code of an open execution whose log has `label`, None when it has no log: the code of
    * its newest state. With no log, or a log no state was written to yet, no unit has run it,
    * so it is Created: nothing that asks for runs in progress counts it.
    */
  def ofOpen(label: Option[ExecutionLabel]): Short =
    label.flatMap(_.state).map(of).getOrElse(WorkflowExecutionStatus.Created)

  /**
    * When an open execution created at `startingTimeMs`, whose log has `label`, took the state
    * it is in: the time of its newest state, which is from its unit's clock and so is never
    * taken to be before the execution was made; and when it was made, while its log shows no
    * state.
    */
  def stateTimeOfOpen(label: Option[ExecutionLabel], startingTimeMs: Long): Long =
    label
      .filter(_.state.nonEmpty)
      .fold(startingTimeMs)(shown => math.max(shown.stateTimeMs, startingTimeMs))
}

/**
  * An open execution of a list, with what its log is found by.
  *
  * @param warehouse      the name of the warehouse it writes into; None when its row names
  *                       none, or names one that was deleted since
  * @param startingTimeMs when it was created, in epoch milliseconds
  */
final case class OpenExecution(
    eid: Long,
    wid: Long,
    warehouse: Option[String],
    startingTimeMs: Long
) {

  /** Its log table, in the warehouse its row names. */
  def logUri: URI =
    ExecutionLogStore.logUri(WorkflowIdentity(wid), ExecutionIdentity(eid), warehouse)
}

/**
  * What a list shows of an open execution.
  *
  * @param status      its status code ([[ExecutionStatus.ofOpen]]);
  *                    [[WorkflowExecutionStatus.Unknown]] when its log cannot be read
  * @param stateTimeMs when it took that state ([[ExecutionStatus.stateTimeOfOpen]]); when it
  *                    was created, when its log cannot be read
  */
final case class OpenStatus(status: Short, stateTimeMs: Long)

object OpenExecutionStatuses {

  /** How many logs a list reads at once, and how long it gives each. */
  val Concurrency = 8
  val ReadLimit: FiniteDuration = 2.seconds

  /** Daemon threads for the reads of every list, let go of after a minute without one. */
  private lazy val readThreads: ExecutorService = {
    val count = new AtomicInteger()
    val pool = new ThreadPoolExecutor(
      4 * Concurrency,
      4 * Concurrency,
      1,
      TimeUnit.MINUTES,
      new LinkedBlockingQueue[Runnable](),
      (task: Runnable) => {
        val thread = new Thread(task, s"execution-status-read-${count.incrementAndGet()}")
        thread.setDaemon(true)
        thread
      }
    )
    pool.allowCoreThreadTimeOut(true)
    pool
  }
}

/**
  * Reads what the lists of executions show of the open ones: the history of a workflow, its
  * latest execution and the admin list. A closed execution's status is in its row; an open
  * one's is the newest state in the label of its log, which is one small read of the lake
  * each, made at most [[OpenExecutionStatuses.Concurrency]] at a time.
  *
  * A list is never failed or held up by the lake: an execution whose log cannot be read in
  * `readLimit`, or is in a warehouse this deployment cannot reach, is shown as
  * [[WorkflowExecutionStatus.Unknown]], which is not known to be any state.
  *
  * @param label             reads the label of the log at a URI; None when there is no log
  * @param warehousesEnabled whether runs write into per-user warehouses
  * @param readLimit         how long the reads of one batch are given
  */
class OpenExecutionStatuses(
    label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    readLimit: FiniteDuration = OpenExecutionStatuses.ReadLimit
) extends LazyLogging {

  /** What is shown of each of `open`, by its execution id. */
  def of(open: Seq[OpenExecution]): Map[Long, OpenStatus] = {
    val (unreachable, readable) = open.partition(execution =>
      ExecutionClosing.warehouseUnavailable(execution.warehouse, warehousesEnabled)
    )
    val read = readable.grouped(OpenExecutionStatuses.Concurrency).flatMap { batch =>
      val reads = batch.map(execution => (() => shown(execution)): Callable[OpenStatus])
      val answers = OpenExecutionStatuses.readThreads
        .invokeAll(reads.asJava, readLimit.toMillis, TimeUnit.MILLISECONDS)
      batch.zip(answers.asScala).map {
        case (execution, answer) =>
          val status =
            try answer.get()
            catch {
              case _: CancellationException =>
                logger.warn(
                  s"The log of execution ${execution.eid} was not read within $readLimit."
                )
                unknown(execution)
              case failed: ExecutionException =>
                // Without the trace: a lake that is down says so for every execution listed.
                logger.warn(
                  s"The log of execution ${execution.eid} could not be read: ${failed.getCause}"
                )
                unknown(execution)
            }
          execution.eid -> status
      }
    }
    (unreachable.map(execution => execution.eid -> unknown(execution)) ++ read).toMap
  }

  private def shown(execution: OpenExecution): OpenStatus = {
    val found = label(execution.logUri)
    OpenStatus(
      ExecutionStatus.ofOpen(found),
      ExecutionStatus.stateTimeOfOpen(found, execution.startingTimeMs)
    )
  }

  private def unknown(execution: OpenExecution): OpenStatus =
    OpenStatus(WorkflowExecutionStatus.Unknown, execution.startingTimeMs)
}
