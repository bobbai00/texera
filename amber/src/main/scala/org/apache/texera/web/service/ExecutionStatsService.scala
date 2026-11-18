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

package org.apache.texera.web.service

import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.{
  ExecutionStatsUpdate,
  FatalError,
  RuntimeStatisticsPersist,
  WorkerAssignmentUpdate,
  WorkflowRecoveryStatus
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.FAILED
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.architecture.worker.statistics.PortTupleMetricsMapping
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.OperatorWorkerMapping
import org.apache.texera.amber.error.ErrorUtils.{
  getOperatorFromActorIdOpt,
  getStackTraceWithAllCauses
}
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.event.{
  ExecutionDurationUpdateEvent,
  OperatorAggregatedMetrics,
  OperatorStatisticsUpdateEvent,
  WorkerAssignmentUpdateEvent
}
import org.apache.texera.web.storage.ExecutionStateStore

import java.time.Instant

/**
  * The statistics of one run: what the engine reports of its operators is shown to the
  * sessions on the workflow, from memory, and handed to the run's record, which stores it in
  * the lake on its own thread.
  */
class ExecutionStatsService(
    client: AmberClient,
    stateStore: ExecutionStateStore
) extends SubscriptionManager
    with LazyLogging {

  registerCallbacks()

  addSubscription(
    stateStore.statsStore.registerDiffHandler((oldState, newState) => {
      // Update operator stats if any operator updates its stat
      if (newState.operatorInfo.toSet != oldState.operatorInfo.toSet) {
        Iterable(
          OperatorStatisticsUpdateEvent(newState.operatorInfo.map {
            case (opId, metrics) =>
              val (inCount, inSize, inMap) =
                summarizePortMetrics(metrics.operatorStatistics.inputMetrics)
              val (outCount, outSize, outMap) =
                summarizePortMetrics(metrics.operatorStatistics.outputMetrics)

              val res = OperatorAggregatedMetrics(
                Utils.aggregatedStateToString(metrics.operatorState),
                inCount,
                inSize,
                inMap,
                outCount,
                outSize,
                outMap,
                metrics.operatorStatistics.numWorkers,
                metrics.operatorStatistics.dataProcessingTime,
                metrics.operatorStatistics.controlProcessingTime,
                metrics.operatorStatistics.idleTime,
                reusedFromCache = metrics.reusedFromCache
              )
              (opId, res)
          })
        )
      } else {
        Iterable.empty
      }
    })
  )

  addSubscription(
    stateStore.statsStore.registerDiffHandler((oldState, newState) => {
      // update operators' workers.
      if (newState.operatorWorkerMapping != oldState.operatorWorkerMapping) {
        newState.operatorWorkerMapping
          .map { opToWorkers =>
            WorkerAssignmentUpdateEvent(opToWorkers.operatorId, opToWorkers.workerIds)
          }
      } else {
        Iterable()
      }
    })
  )

  addSubscription(
    stateStore.statsStore.registerDiffHandler((oldState, newState) => {
      // update execution duration.
      if (
        newState.startTimeStamp != oldState.startTimeStamp || newState.endTimeStamp != oldState.endTimeStamp
      ) {
        if (newState.endTimeStamp != 0) {
          Iterable(
            ExecutionDurationUpdateEvent(
              newState.endTimeStamp - newState.startTimeStamp,
              isRunning = false
            )
          )
        } else {
          val currentTime = System.currentTimeMillis()
          Iterable(
            ExecutionDurationUpdateEvent(currentTime - newState.startTimeStamp, isRunning = true)
          )
        }
      } else {
        Iterable()
      }
    })
  )

  private[this] def registerCallbacks(): Unit = {
    registerCallbackOnWorkflowStatsUpdate()
    registerCallbackOnWorkerAssignedUpdate()
    registerCallbackOnWorkflowRecoveryUpdate()
    registerCallbackOnFatalError()
  }

  private[this] def registerCallbackOnWorkflowStatsUpdate(): Unit = {
    // Register callback for UI updates (UI state store update only, no persistence)
    addSubscription(
      client
        .registerCallback[ExecutionStatsUpdate]((evt: ExecutionStatsUpdate) => {
          stateStore.statsStore.updateState { statsStore =>
            statsStore.withOperatorInfo(evt.operatorMetrics)
          }
        })
    )

    // Register callback for statistics persistence (persistence only, no UI update): the run's
    // record keeps the newest numbers, and stores them at its next commit.
    addSubscription(
      client
        .registerCallback[RuntimeStatisticsPersist]((evt: RuntimeStatisticsPersist) => {
          stateStore.recorder.statistics(evt.operatorMetrics)
        })
    )
  }

  /** The tuples and the bytes `portMetrics` count in all, and the tuples of each port by its id. */
  private def summarizePortMetrics(
      portMetrics: Seq[PortTupleMetricsMapping]
  ): (Long, Long, Map[String, Long]) = {
    val perPortCounts = Map.newBuilder[String, Long]
    var totalCount = 0L
    var totalSize = 0L
    portMetrics.foreach { pm =>
      val count = pm.tupleMetrics.count
      totalCount += count
      totalSize += pm.tupleMetrics.size
      perPortCounts += (pm.portId.id.toString -> count)
    }
    (totalCount, totalSize, perPortCounts.result())
  }

  private[this] def registerCallbackOnWorkerAssignedUpdate(): Unit = {
    addSubscription(
      client
        .registerCallback[WorkerAssignmentUpdate]((evt: WorkerAssignmentUpdate) => {
          stateStore.statsStore.updateState { statsStore =>
            statsStore.withOperatorWorkerMapping(
              evt.workerMapping
                .map({
                  case (opId, workerIds) => OperatorWorkerMapping(opId, workerIds.toSeq)
                })
                .toSeq
            )
          }
        })
    )
  }

  private[this] def registerCallbackOnWorkflowRecoveryUpdate(): Unit = {
    addSubscription(
      client
        .registerCallback[WorkflowRecoveryStatus]((evt: WorkflowRecoveryStatus) => {
          stateStore.metadataStore.updateState { metadataStore =>
            metadataStore.withIsRecovering(evt.isRecovering)
          }
        })
    )
  }

  private[this] def registerCallbackOnFatalError(): Unit = {
    addSubscription(
      client
        .registerCallback[FatalError]((evt: FatalError) => {
          client.shutdown()
          val (operatorId, workerId) = getOperatorFromActorIdOpt(evt.fromActor)
          logger.error("error occurred in execution", evt.e)
          stateStore.transitionTo(
            FAILED,
            errors = Seq(
              WorkflowFatalError(
                EXECUTION_FAILURE,
                Timestamp(Instant.now),
                evt.e.toString,
                getStackTraceWithAllCauses(evt.e),
                operatorId,
                workerId
              )
            )
          )
        })
    )
  }
}
