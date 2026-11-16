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

import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlanCodec, WorkflowContext}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.common.compiler.model.{LogicalPlan, LogicalPlanPojo}
import org.apache.texera.common.compiler.{CompilationErrorHandling, WorkflowCompiler}

/**
  * The plan of a run as the engine is handed it: saved, as text.
  *
  * Starting a run has two halves. [[PlanToRun.make]] compiles the run's workflow and saves the
  * physical plan, with the settings it runs under, as the JSON [[PhysicalPlanCodec]] writes. The
  * engine starts from that text and the logical plan ([[WorkflowExecutionService.workflowToRun]]):
  * it runs the physical plan read back from the text, under the settings read back with it, and
  * never sees the plan the compile made. Both halves run on the computing unit for now; making the
  * plan is meant to move to the Dashboard service, which will store the text with the execution
  * for the unit to read by execution id.
  *
  * @param savedPlan   the physical plan to run, its settings and what else the run needs (an
  *                    [[org.apache.texera.amber.core.workflow.ExecutionPlan]]), as JSON text. It
  *                    holds what each operator's executor is given, so it holds the credentials
  *                    an operator is set up with (a SQL source's password, say): keep it where
  *                    they may be kept.
  * @param logicalPlan the logical plan the physical plan was compiled from. It is not part of the
  *                    saved plan: the engine still reads it to check and compile an operator
  *                    changed while the run is paused, and to remember the last plan that
  *                    completed.
  */
final case class PlanToRun(savedPlan: String, logicalPlan: LogicalPlan)

object PlanToRun {

  /**
    * Makes, from `logicalPlan`, the plan to run for the run `compiler` was made for, and saves it.
    *
    * The run is the compiler's context: its ids stamp every operator, and the plan is saved with
    * its settings, warehouse and cost hints. The compile is Strict: a workflow with an error
    * fails here, and nothing is saved. It pins the datasets and models the operators name, and
    * finds the output ports whose results are stored, which are saved with the settings. The
    * run's context is left as it is; the engine takes the settings and cost hints from the saved
    * plan. The plan saved replays nothing, writes no replay log and reads no input.
    *
    * @param compiler the run's compiler: it resolves files, datasets and models as the run's user
    *                 may, and writes code against the mount root of the unit the run is on
    * @throws IllegalArgumentException if the run's settings send batches of fewer than one tuple,
    *                                  or its cost hints are not ones a plan is saved with: from
    *                                  an execution whose id is below 1, for an operator with no
    *                                  id, or with a cost that is not a finite number of seconds,
    *                                  at least 0
    */
  def make(compiler: WorkflowCompiler, logicalPlan: LogicalPlanPojo): PlanToRun = {
    val run = compiler.context
    val batchSize = run.workflowSettings.dataTransferBatchSize
    // Checked first, in the words of the editor's setting; the codec refuses such a plan too.
    if (batchSize < 1) {
      throw new IllegalArgumentException(
        s"The workflow's Data Transfer Batch Size is $batchSize; set it to 1 or more."
      )
    }
    // The context the plan is saved under: the run's, but for its computing unit, which a plan
    // does not choose. The compile adds the ports whose results are stored to its settings.
    val savedUnder =
      new WorkflowContext(
        run.workflowId,
        run.executionId,
        run.workflowSettings,
        None,
        run.warehouse,
        run.costHints
      )
    val compiled = Workflow.fromCompilationResult(
      savedUnder,
      compiler.compile(logicalPlan, CompilationErrorHandling.Strict)
    )
    PlanToRun(
      PhysicalPlanCodec.toJson(
        PhysicalPlanCodec.encode(ExecutionPlan(compiled.context, compiled.physicalPlan))
      ),
      compiled.logicalPlan
    )
  }
}
