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

import org.apache.texera.amber.core.storage.{FileResolver, RepositoryMountManager}
import org.apache.texera.amber.core.workflow.{
  ExecutionPlan,
  PhysicalPlanCodec,
  ReplaySource,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{
  CompilationErrorHandling,
  CompileSettings,
  RunBindings,
  WorkflowCompiler
}

import java.net.URI

/**
  * The plan of a run as the engine is handed it: saved, as text.
  *
  * Starting a run has two halves. [[PlanToRun.make]] compiles the run's workflow and saves the
  * physical plan, with the settings it runs under, as the JSON [[PhysicalPlanCodec]] writes: the
  * Dashboard service makes the plan of each execution it creates
  * ([[org.apache.texera.web.service.execution.ExecutionCreator]]) and writes the text to the
  * execution's plan table. The computing unit that starts the execution reads the text back from
  * there ([[WorkflowService.checkStoredStart]]) and runs the physical plan it holds, under the
  * settings, replay and replay log saved with it: the engine never sees the plan the compile
  * made.
  *
  * @param savedPlan the physical plan to run, its settings and what else the run needs (an
  *                  [[org.apache.texera.amber.core.workflow.ExecutionPlan]]), as JSON text. It
  *                  holds what each operator's executor is given, so it holds the credentials an
  *                  operator is set up with (a SQL source's password, say): keep it where they
  *                  may be kept.
  */
final case class PlanToRun(savedPlan: String)

object PlanToRun {

  /**
    * Why no plan can be made to run under `settings`, if none can: batches of fewer than one
    * tuple. In the words of the editor's setting, for a caller that refuses such settings before
    * it calls [[make]], which refuses them too.
    */
  def settingsProblem(settings: WorkflowSettings): Option[String] =
    Option.when(settings.dataTransferBatchSize < 1)(
      s"The workflow's Data Transfer Batch Size is ${settings.dataTransferBatchSize}; set it to " +
        "1 or more."
    )

  /**
    * What a plan made to run for user `uid` is bound to: the files, datasets and models that
    * user may read, the directory this deployment's computing units mount datasets and models
    * under, and the site's settings as they stand now.
    */
  def bindingsFor(uid: Integer): RunBindings =
    RunBindings(
      files = FileResolver.forUser(uid),
      repositories = FileResolver.repositoryVersionResolverForUser(uid),
      mountRoot = RepositoryMountManager.mountRoot,
      settings = CompileSettings.fromSiteSettings()
    )

  /**
    * Makes, from `logicalPlan`, the plan to run for the run `compiler` was made for, and saves it.
    *
    * The run is the compiler's context: its ids stamp every operator, and the plan is saved with
    * its settings, warehouse and cost hints. The compile is Strict: a workflow with errors fails
    * here, with each operator's first error, and nothing is saved. It pins the datasets and
    * models the operators name, and finds the output ports whose results are stored, which are
    * saved with the settings. The run's context is left as it is; the engine takes the settings
    * and cost hints from the saved plan. The plan saved replays `replay`, writes its replay log
    * to `replayLog`, and reads no input.
    *
    * @param compiler  the run's compiler, bound for the run's user ([[bindingsFor]]): it resolves
    *                  files, datasets and models as that user may, and writes code against the
    *                  root the deployment's computing units mount datasets and models under
    * @param replay    the replay log the run replays, up to one interaction; None for none
    * @param replayLog where the run writes its replay log; None for nowhere
    * @throws org.apache.texera.common.compiler.WorkflowCompilationFailed if the workflow has errors
    * @throws IllegalArgumentException if the run's settings are ones it cannot run under
    *                                  ([[settingsProblem]]), its cost hints are not ones a plan
    *                                  is saved with (from an execution whose id is below 1, for
    *                                  an operator with no id, or with a cost that is not a
    *                                  finite number of seconds, at least 0), or it replays or
    *                                  writes a replay log at a location that is not an absolute
    *                                  URI, replays the log of an execution whose id is below 1,
    *                                  or replays up to a blank interaction
    */
  def make(
      compiler: WorkflowCompiler,
      logicalPlan: LogicalPlanPojo,
      replay: Option[ReplaySource] = None,
      replayLog: Option[URI] = None
  ): PlanToRun = {
    val run = compiler.context
    // Checked first, in the words of the editor's settings; the codec refuses such a plan too.
    settingsProblem(run.workflowSettings).foreach(problem =>
      throw new IllegalArgumentException(problem)
    )
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
        PhysicalPlanCodec.encode(
          ExecutionPlan(compiled.context, compiled.physicalPlan, replay, replayLog)
        )
      )
    )
  }
}
