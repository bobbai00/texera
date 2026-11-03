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

package org.apache.texera.amber.engine.architecture.scheduling

import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.engine.architecture.scheduling.DefaultCostEstimator.DEFAULT_OPERATOR_COST
import org.apache.texera.amber.engine.architecture.scheduling.config.ResourceConfig
import org.apache.texera.amber.engine.architecture.scheduling.resourcePolicies.ResourceAllocator
import org.apache.texera.amber.engine.common.AmberLogging

import java.net.URI
import scala.util.{Failure, Success, Try}

/**
  * A cost estimator should estimate a cost of running a region under the given resource constraints as units.
  */
trait CostEstimator {

  /**
    * Uses the given resource units to allocate resources to the region, and determine a cost based on the allocation.
    *
    * Note currently the ResourceAllocator is not cost-based and thus we use a cost model that does not rely on the
    * allocator, i.e., the cost estimation process is external to the ResourceAllocator.
    * @return A ResourceConfig for the region and an estimated cost of this region.
    */
  def allocateResourcesAndEstimateCost(region: Region, resourceUnits: Int): (ResourceConfig, Double)
}

object DefaultCostEstimator {
  val DEFAULT_OPERATOR_COST: Double = 1.0
}

/**
  * A default cost estimator using past statistics. If past statistics of a workflow are available, the cost of a region
  * is the execution time of its longest-running operator. Otherwise the cost is the number of materialized ports in the
  * region.
  */
class DefaultCostEstimator(
    workflowContext: WorkflowContext,
    val resourceAllocator: ResourceAllocator,
    val actorId: ActorVirtualIdentity
) extends CostEstimator
    with AmberLogging {

  // Past statistics come with the workflow context; without them the cost is the number of
  // materialized ports.
  private val operatorEstimatedTimeOption = Try(
    this.workflowContext.pastRuntimeStatistics.flatMap(getOperatorExecutionTimeInSeconds)
  ) match {
    case Failure(_)      => None
    case Success(result) => result
  }

  operatorEstimatedTimeOption match {
    case None =>
      logger.info(
        s"WID: ${workflowContext.workflowId.id}, EID: ${workflowContext.executionId.id}, " +
          s"no past execution statistics available. Using number of materialized output ports as the cost. "
      )
    case Some(_) =>
  }

  override def allocateResourcesAndEstimateCost(
      region: Region,
      resourceUnits: Int
  ): (ResourceConfig, Double) = {
    // Currently the dummy cost from resourceAllocator is discarded.
    val (resourceConfig, _) = resourceAllocator.allocate(region)
    // We use a cost model that does not rely on the resource allocation.
    // TODO: Once the ResourceAllocator actually calculates a cost, we can use its calculated cost.
    val cost = this.operatorEstimatedTimeOption match {
      case Some(operatorEstimatedTime) =>
        // Use past statistics (wall-clock runtime). We use the execution time of the longest-running
        // operator in each region to represent the region's execution time, and use the sum of all the regions'
        // execution time as the wall-clock runtime of the workflow.
        // This assumes a schedule is a total-order of the regions.
        val opExecutionTimes = region.getOperators.map(op => {
          operatorEstimatedTime.getOrElse(op.id.logicalOpId.id, DEFAULT_OPERATOR_COST)
        })
        val longestRunningOpExecutionTime = opExecutionTimes.max
        longestRunningOpExecutionTime
      case None =>
        // Without past statistics (e.g., first execution), we use number of ports needing storage as the cost.
        // Each port needing storage has a portConfig.
        // This is independent of the schedule / resource allocator.
        resourceConfig.portConfigs.size
    }
    (resourceConfig, cost)
  }

  /**
    * Each operator's cost from a past run's runtime statistics: the most control plus data
    * processing time any of its workers reported, in seconds. None when the document is empty.
    */
  private def getOperatorExecutionTimeInSeconds(statistics: URI): Option[Map[String, Double]] = {
    val maxStats = DocumentFactory
      .openDocument(statistics)
      ._1
      .get()
      .foldLeft(Map.empty[String, Double]) { (acc, tuple) =>
        val record = tuple.asInstanceOf[Tuple]
        val operatorId = record.getField(0).asInstanceOf[String]
        val dataProcessingTime = record.getField(6).asInstanceOf[Long]
        val controlProcessingTime = record.getField(7).asInstanceOf[Long]
        val newTime = (dataProcessingTime + controlProcessingTime) / 1e9
        acc + (operatorId -> Math.max(acc.getOrElse(operatorId, 0.0), newTime))
      }
    if (maxStats.isEmpty) None else Some(maxStats)
  }
}
