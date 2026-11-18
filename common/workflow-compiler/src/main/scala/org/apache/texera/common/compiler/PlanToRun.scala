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

package org.apache.texera.common.compiler

import org.apache.texera.amber.core.storage.{
  FileResolver,
  LakeFSDatasetVersionLister,
  LakeFSInputFileLocator
}
import org.apache.texera.amber.core.workflow.{
  ExecutionPlan,
  PhysicalPlanCodec,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.common.compiler.model.LogicalPlanPojo

/**
  * Makes the plan of a run: the workflow compiled for the run's user, as the text
  * [[PhysicalPlanCodec]] writes.
  *
  * The workflow compiling service makes the plan of each execution the Dashboard service
  * creates, with the access of the user who creates it. The plan made here takes no secret: it
  * says where each file its operators read is kept, and the Dashboard service, which holds the
  * object store's keys, signs a link to each, adds what else the run needs and writes the plan
  * to the execution's plan table. The computing unit that starts the execution runs the plan it
  * reads from there: the engine never sees the plan the compile made.
  */
object PlanToRun {

  /**
    * A plan made to run.
    *
    * @param plan        the physical plan to run and its settings, as JSON text, before its
    *                    files are linked ([[PhysicalPlanCodec.decodeUnlinked]] reads it). It
    *                    holds what each operator's executor is given, so it holds the
    *                    credentials an operator is set up with (a SQL source's password, say):
    *                    keep it where they may be kept, and out of logs.
    * @param logicalPlan the workflow the plan was compiled from, as JSON that parses back to it
    *                    ([[LogicalPlanPojo.toJson]]): with a target, the part of the workflow
    *                    sent that was compiled
    */
  final case class Made(plan: String, logicalPlan: String)

  /**
    * What a plan made to run for user `uid` is bound to: the files, datasets and models that
    * user may read, with where LakeFS keeps each file, the site's settings as they stand now,
    * and the Python environments that user keeps. It reads the database and LakeFS, and needs
    * none of the object store's keys.
    */
  def bindingsFor(uid: Integer): CompileFor.Run =
    CompileFor.Run(
      files = FileResolver.forUser(uid),
      settings = CompileSettings.fromSiteSettings(),
      locator = LakeFSInputFileLocator,
      lister = LakeFSDatasetVersionLister.forUser(uid),
      repositories = FileResolver.repositoryVersionResolverForUser(uid),
      environments = new UserEnvironmentResolver(uid)
    )

  /**
    * Compiles `workflow` or, with a target, the target and the part of the workflow upstream of
    * it: only that part has to be a graph the compiler reads, and a part the run does not reach
    * is neither compiled nor checked. The run's ids stamp every operator. The compile finds the
    * files the operators read and where each is kept, lists the dataset versions File Listers
    * name, resolves the Python environments and pins the datasets and models the operators
    * name, names where each output port is stored, and finds the output ports whose results are
    * stored, which are saved with the settings in place of any the run's settings name. The
    * run's context is left as it is.
    *
    * @param bindings what the plan is bound to, for the run's user ([[bindingsFor]])
    * @param target   the operator the run executes up to; None for the whole workflow
    * @throws WorkflowRefused           if the run's settings, `target` or the workflow's graph
    *                                   allow no plan, with why
    * @throws WorkflowCompilationFailed if an operator has an error
    */
  def make(
      run: WorkflowContext,
      bindings: CompileFor.Run,
      workflow: LogicalPlanPojo,
      target: Option[String] = None
  ): Made = {
    def refuse(problem: String): Nothing = throw new WorkflowRefused(problem)
    // Checked first, in the words of the editor's settings; the codec refuses such a plan too.
    WorkflowSettings.problemOf(run.workflowSettings).foreach(refuse)
    if (workflow == null) refuse("The request has no logical plan.")
    workflow.listProblem().foreach(refuse)
    // Lists a client may leave out, which the compiler reads.
    val whole = workflow.copy(
      opsToViewResult = Option(workflow.opsToViewResult).getOrElse(Nil),
      opsToReuseResult = Option(workflow.opsToReuseResult).getOrElse(Nil)
    )
    val toCompile = target match {
      case Some(operator) =>
        if (!whole.operators.exists(_.operatorIdentifier.id == operator)) {
          refuse(s"The workflow has no operator $operator to run up to.")
        }
        whole.upstreamOf(operator)
      case None => whole
    }
    toCompile.graphProblem().foreach(refuse)
    // The plan compiled, as it was sent, loop-variable references included: written before the
    // compile resolves its operators in place.
    val logicalPlan = toCompile.toJson
    val result = new WorkflowCompiler(run, bindings).compile(toCompile)
    // The context the plan is saved under: a copy of the run's, with the ports whose results
    // are stored, which the compile found, in its settings.
    val savedUnder =
      new WorkflowContext(
        run.workflowId,
        run.executionId,
        run.workflowSettings.copy(outputPortsNeedingStorage = result.outputPortsNeedingStorage),
        run.warehouse
      )
    // A compile for a run throws an operator's error, so its result holds a plan.
    Made(
      PhysicalPlanCodec.toJson(
        PhysicalPlanCodec.encodeUnlinked(ExecutionPlan(savedUnder, result.physicalPlan.get))
      ),
      logicalPlan
    )
  }
}
