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

package org.apache.texera.amber.engine.architecture.coordinator

import org.apache.texera.amber.core.workflow.{PhysicalPlan, WorkflowContext}
import org.apache.texera.common.compiler.WorkflowCompilationResult
import org.apache.texera.common.compiler.model.LogicalPlan

case class Workflow(
    context: WorkflowContext,
    logicalPlan: LogicalPlan,
    physicalPlan: PhysicalPlan
)

object Workflow {

  /**
    * The `Workflow` a Strict-mode compilation result holds, with the physical plan as the compile
    * made it. Also writes the result's `outputPortsNeedingStorage` onto the context, whose
    * settings the plan runs under, so the schedule generators materialize terminal results —
    * every caller must do both, so they are kept together here. Strict mode guarantees
    * `physicalPlan` is defined.
    *
    * A run does not run this plan: [[org.apache.texera.web.service.PlanToRun.make]] saves it
    * under a context of its own, which this writes the stored ports onto, and the engine runs
    * the plan read back from what was saved, under the settings saved with it.
    */
  def fromCompilationResult(
      context: WorkflowContext,
      compilationResult: WorkflowCompilationResult
  ): Workflow = {
    val physicalPlan = compilationResult.physicalPlan.getOrElse(
      throw new IllegalStateException(
        "fromCompilationResult requires a compilation result with a defined physicalPlan " +
          "(compile with CompilationErrorHandling.Strict); this result carries " +
          s"${compilationResult.operatorIdToError.size} compilation error(s) instead"
      )
    )
    context.workflowSettings = context.workflowSettings.copy(
      outputPortsNeedingStorage = compilationResult.outputPortsNeedingStorage
    )
    Workflow(context, compilationResult.logicalPlan, physicalPlan)
  }
}
