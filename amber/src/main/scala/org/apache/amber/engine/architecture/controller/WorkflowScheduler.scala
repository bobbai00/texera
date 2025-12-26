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

package org.apache.amber.engine.architecture.controller

import org.apache.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.amber.core.workflow.{GlobalPortIdentity, PhysicalPlan, WorkflowContext}
import org.apache.amber.engine.architecture.scheduling.{
  CostBasedScheduleGenerator,
  PortResultCache,
  Region,
  Schedule
}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource

import java.net.URI

class WorkflowScheduler(
    workflowContext: WorkflowContext,
    actorId: ActorVirtualIdentity
) extends java.io.Serializable {
  var physicalPlan: PhysicalPlan = _
  private var schedule: Schedule = _
  private var cachedViewResultPorts: Map[GlobalPortIdentity, URI] = Map.empty

  def getSchedule: Schedule = schedule

  /**
    * Update the schedule to be executed, based on the given physicalPlan.
    */
  def updateSchedule(physicalPlan: PhysicalPlan): Unit = {
    // generate a schedule using a region plan generator.
    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflowContext,
      physicalPlan,
      actorId
    )
    val (generatedSchedule, updatedPhysicalPlan) = scheduleGenerator.generate()
    this.schedule = generatedSchedule
    this.physicalPlan = updatedPhysicalPlan

    // Store cached view-result ports for later registration
    this.cachedViewResultPorts = scheduleGenerator.getCachedViewResultPorts

    // Register cached view-result URIs with WorkflowExecutionsResource
    // so they appear as results in the frontend
    cachedViewResultPorts.foreach {
      case (portId, uri) =>
        WorkflowExecutionsResource.insertOperatorPortResultUri(
          workflowContext.executionId,
          portId,
          uri
        )
    }

    // Store fully cached operators with their data for stats display
    val fullyCachedOperators = scheduleGenerator.getFullyCachedOperatorsWithData
    if (fullyCachedOperators.nonEmpty) {
      PortResultCache.storeCachedOperatorsForExecution(
        workflowContext.executionId,
        fullyCachedOperators
      )
    }
  }

  def getNextRegions: Set[Region] = if (!schedule.hasNext) Set() else schedule.next()

  /**
    * Check if the schedule is empty (all operators are cached).
    * When this returns true, the workflow should complete immediately.
    */
  def isScheduleEmpty: Boolean = !schedule.hasNext

  /**
    * Check if there are cached view-result ports.
    */
  def hasCachedViewResultPorts: Boolean = cachedViewResultPorts.nonEmpty

}
