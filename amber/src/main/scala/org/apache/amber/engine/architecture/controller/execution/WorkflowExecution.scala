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

package org.apache.amber.engine.architecture.controller.execution

import org.apache.amber.core.virtualidentity.{ExecutionIdentity, PhysicalOpIdentity}
import org.apache.amber.engine.architecture.controller.execution.ExecutionUtils.aggregateMetrics
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.amber.engine.architecture.scheduling.{PortResultCache, Region, RegionIdentity}
import org.apache.amber.engine.architecture.worker.statistics.{PortTupleMetricsMapping, TupleMetrics}
import org.apache.amber.engine.common.executionruntimestate.{OperatorMetrics, OperatorStatistics}

import scala.collection.mutable

case class WorkflowExecution(executionId: Option[ExecutionIdentity] = None) {

  // region executions are stored with LinkedHashMap to maintain their creation order.
  private val regionExecutions: mutable.LinkedHashMap[RegionIdentity, RegionExecution] =
    mutable.LinkedHashMap()

  /**
    * Initializes or retrieves a `RegionExecution` for a given `Region`. If not already
    * initialized, it creates and returns a new `RegionExecution`; otherwise, an assertion
    * error is thrown if re-initialization is attempted.
    *
    * @param region The `Region` for which to initialize or retrieve the `RegionExecution`.
    * @return The `RegionExecution` associated with the given `Region`.
    * @throws AssertionError if the `RegionExecution` has already been initialized.
    */
  def initRegionExecution(region: Region): RegionExecution = {
    // ensure the region execution hasn't been initialized already.
    assert(
      !regionExecutions.contains(region.id),
      s"RegionExecution of ${region.id} already initialized."
    )
    regionExecutions.getOrElseUpdate(region.id, RegionExecution(region))
  }

  /**
    * Retrieves a specific `RegionExecution` by its identifier.
    *
    * @param regionId The unique identifier of the region for which the execution is to be retrieved.
    * @return The `RegionExecution` associated with the specified `regionId`.
    */
  def getRegionExecution(regionId: RegionIdentity): RegionExecution = regionExecutions(regionId)

  /**
    * Retrieves all `RegionExecutions` that are currently in running state,
    * preserving the order in which they were created.
    *
    * This method filters the executions to include only those that have not completed.
    *
    * @return An `Iterable` of `RegionExecution` objects that are in running state.
    */
  def getRunningRegionExecutions: Iterable[RegionExecution] = {
    regionExecutions.values.filterNot(_.isCompleted)
  }

  /**
    * Retrieve the runtime stats of all `RegionExecutions`
    *
    * @return A `Map` with key being `Logical Operator ID` and the value being operator runtime statistics
    */
  def getAllRegionExecutionsStats: Map[String, OperatorMetrics] = {
    val allRegionExecutions: Iterable[RegionExecution] = getAllRegionExecutions

    val statsMap: Map[PhysicalOpIdentity, OperatorMetrics] = allRegionExecutions.flatMap {
      regionExecution =>
        regionExecution.getStats.map {
          case (physicalOpIdentity, operatorMetrics) =>
            (physicalOpIdentity, operatorMetrics)
        }
    }.toMap

    // Add stats from cached operators (operators that were skipped due to cache hits)
    val cachedStats: Map[PhysicalOpIdentity, OperatorMetrics] = getCachedOperatorStats

    // Merge running stats with cached stats
    val allStats = statsMap ++ cachedStats

    val aggregatedStats: Map[String, OperatorMetrics] =
      allStats.groupBy(_._1.logicalOpId.id).map {
        case (logicalOpId, stats) =>
          (logicalOpId, aggregateMetrics(stats.values))
      }
    aggregatedStats
  }

  /**
    * Get stats for cached operators (operators that were skipped because all outputs were cached).
    */
  private def getCachedOperatorStats: Map[PhysicalOpIdentity, OperatorMetrics] = {
    executionId match {
      case Some(eid) =>
        val cachedOperators = PortResultCache.getCachedOperatorsForExecution(eid)
        cachedOperators.map {
          case (opId, cachedData) =>
            // Create input metrics from cached data
            val inputMetrics: Seq[PortTupleMetricsMapping] = cachedData.inputPortMetrics.map {
              case (portId, metrics) =>
                PortTupleMetricsMapping(portId, TupleMetrics(metrics.tupleCount, 0L))
            }.toSeq

            // Create output metrics from cached data
            val outputMetrics: Seq[PortTupleMetricsMapping] = cachedData.outputPortMetrics.map {
              case (portId, metrics) =>
                PortTupleMetricsMapping(portId, TupleMetrics(metrics.tupleCount, 0L))
            }.toSeq

            // Create OperatorMetrics for the cached operator
            val metrics = OperatorMetrics(
              operatorState = WorkflowAggregatedState.COMPLETED,
              operatorStatistics = OperatorStatistics(
                inputMetrics = inputMetrics,
                outputMetrics = outputMetrics,
                numWorkers = 0, // Cached operators have no workers
                dataProcessingTime = 0L,
                controlProcessingTime = 0L,
                idleTime = 0L
              )
            )
            opId -> metrics
        }
      case None =>
        Map.empty
    }
  }

  /**
    * Retrieves all `RegionExecutions`, preserving the order in which they were created.
    *
    * This method provides access to all executions, regardless of their state.
    *
    * @return An `Iterable` of all `RegionExecution` objects in the order they were added.
    */
  def getAllRegionExecutions: Iterable[RegionExecution] = regionExecutions.values

  /**
    * Checks if there is any `OperatorExecution` associated with the specified physical operatorId.
    *
    * This method is useful for checking if an operator was scheduled and executed, as opposed to
    * being skipped due to cache hits or other optimizations.
    *
    * @param physicalOpId The unique identifier of the physical operator to check.
    * @return true if an `OperatorExecution` exists for this operator, false otherwise.
    */
  def hasOperatorExecution(physicalOpId: PhysicalOpIdentity): Boolean = {
    regionExecutions.values.exists(_.hasOperatorExecution(physicalOpId))
  }

  /**
    * Retrieves the latest `OperatorExecution` associated with the specified physical operatorId.
    *
    * This method searches through all `RegionExecutions` in reverse creation order to find the most recent
    * `OperatorExecution` that matches the given physical operatorId. It assumes that each `RegionExecution`
    * may contain zero or exactly one `OperatorExecution` instance, and it returns the latest one found that
    * corresponds to the specified operatorId.
    *
    * @param physicalOpId The unique identifier of the physical operator for which the latest execution is
    *                     to be retrieved.
    * @return The latest `OperatorExecution` instance associated with the given physical operatorId.
    * @throws NoSuchElementException if no `OperatorExecution` is found for the specified operatorId.
    */
  def getLatestOperatorExecution(physicalOpId: PhysicalOpIdentity): OperatorExecution = {
    regionExecutions.values.toList
      .findLast(regionExecution => regionExecution.hasOperatorExecution(physicalOpId))
      .get
      .getOperatorExecution(physicalOpId)
  }

  def isCompleted: Boolean = getState == WorkflowAggregatedState.COMPLETED

  def getState: WorkflowAggregatedState = {
    val regionStates = regionExecutions.values.map(_.getState)
    if (regionStates.isEmpty) {
      return WorkflowAggregatedState.UNINITIALIZED
    }
    if (regionStates.forall(_ == COMPLETED)) {
      return WorkflowAggregatedState.COMPLETED
    }
    val unCompletedOpStates = regionExecutions.values
      .filter(_.getState != COMPLETED)
      .flatMap(_.getAllOperatorExecutions.map(_._2.getState))
      .filter(_ != COMPLETED)
    if (unCompletedOpStates.forall(_ == UNINITIALIZED)) {
      return WorkflowAggregatedState.UNINITIALIZED
    }
    val runningOpStates = unCompletedOpStates.filter(_ != UNINITIALIZED)
    if (runningOpStates.exists(_ == RUNNING)) {
      WorkflowAggregatedState.RUNNING
    } else if (runningOpStates.forall(_ == PAUSED)) {
      WorkflowAggregatedState.PAUSED
    } else if (runningOpStates.forall(_ == READY)) {
      WorkflowAggregatedState.READY
    } else {
      WorkflowAggregatedState.UNKNOWN
    }
  }

}
