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

import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.state.StateReferencing
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{PhysicalOp, PhysicalPlanCodec}
import org.apache.texera.amber.operator.{LogicalOp, StateTransferFunc}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.{LogicalPlan, LogicalPlanPojo}

import scala.util.{Failure, Success, Try}

/**
  * Makes a change to one operator of a paused execution into the operator to run in its place:
  * the change compiled as the execution's plan was, for the user who created the execution, as
  * the text [[PhysicalPlanCodec]] writes an operator's update in.
  *
  * The workflow compiling service makes it, for the Dashboard service to store beside the
  * execution's plan. Nothing a compile finds for a run but the datasets and models a change
  * names is found for a change: an operator that takes a change while it runs reads no file and
  * no listing, and keeps its Python environment.
  */
object UpdateToRun {

  /**
    * Builds the operator that an operator of the workflow an execution runs becomes once changed:
    * given the operator, the operator as changed, the workflow and the execution.
    */
  type Reconfigure =
    (LogicalOp, LogicalOp, WorkflowIdentity, ExecutionIdentity) => Try[
      (PhysicalOp, Option[StateTransferFunc])
    ]

  /** The operator builds what a change makes of it itself ([[LogicalOp.runtimeReconfiguration]]). */
  val byTheOperator: Reconfigure = (current, changed, workflowId, executionId) =>
    current.runtimeReconfiguration(workflowId, executionId, current, changed)

  /**
    * A physical operator the execution's plan runs for the operator a change is made to.
    *
    * @param layerName         the operator's layer, which with the logical operator's id is its
    *                          id in the plan
    * @param pythonEnvironment the name of the Python environment its workers run in; None for
    *                          the engine's own
    */
  final case class RunningOperator(layerName: String, pythonEnvironment: Option[String])

  /**
    * A change made to run.
    *
    * @param update   the operator made to run, as its executor and what its code reads, saved
    *                 under the update's id ([[PhysicalPlanCodec.updateToJson]])
    * @param operator the change as it was sent, as JSON that parses back to it: written as the
    *                 logical plan of a run is ([[LogicalPlanPojo.toJson]]), without the
    *                 loop-variable sidecar
    */
  final case class Made(update: String, operator: String)

  /**
    * Makes `changed` into the operator that takes the place of the operator of its id in
    * execution `executionId`, and saves it under `updateId`.
    *
    * The change must keep the operator's type, refer to no loop variable, be one the operator
    * takes while it runs, make an operator the execution runs, keep the Python environment that
    * operator runs in, and name only datasets and models `repositories` pins.
    *
    * @param workflow     the workflow the execution's plan was compiled from
    * @param changed      the operator as the editor holds it once changed, under the id it has
    *                     in `workflow`
    * @param running      the physical operators the execution's plan runs for that operator
    * @param repositories pins the dataset and model versions the change names, for the user who
    *                     created the execution ([[WorkflowCompiler.bindResources]])
    * @throws NoSuchOperator        if `workflow` has no operator of the change's id
    * @throws WorkflowRefused       if the change names no operator by an id, or is not one the
    *                               running operator can take, with why
    * @throws IllegalStateException if `workflow` is not a graph the compiler reads, which a
    *                               workflow a plan was compiled from always is
    */
  def make(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      updateId: String,
      workflow: LogicalPlanPojo,
      changed: LogicalOp,
      running: Seq[RunningOperator],
      repositories: RepositoryVersionResolver,
      reconfigure: Reconfigure = byTheOperator
  ): Made = {
    def refuse(message: String): Nothing = throw new WorkflowRefused(message)
    if (changed == null) refuse("The request names no operator.")
    val operatorId = changed.operatorIdentifier
    if (Option(operatorId.id).forall(_.isBlank)) refuse("The operator to change has no id.")
    // Written before the change is made to run. A change that refers to a loop variable is
    // refused below, so the change written has no typed reference to put back.
    val sent = objectMapper.writeValueAsString(
      StateReferencing.restoreReferences(objectMapper.valueToTree[ObjectNode](changed))
    )
    if (workflow == null) {
      throw new IllegalStateException("The execution's workflow is missing.")
    }
    workflow.graphProblem().foreach(problem => throw new IllegalStateException(problem))
    val plan = LogicalPlan(workflow)
    val current = plan.operators.find(_.operatorIdentifier == operatorId).getOrElse {
      throw new NoSuchOperator(
        s"Operator ${operatorId.id} is not in the workflow execution ${executionId.id} runs."
      )
    }
    val name = current.operatorInfo.userFriendlyName
    // A descriptor builds the new operator from whatever it is handed, of any type: the running
    // worker would be given another operator's executor.
    if (changed.getClass != current.getClass) {
      refuse(
        s"Operator ${operatorId.id} is a $name; a change cannot make it a " +
          s"${changed.operatorInfo.userFriendlyName}."
      )
    }
    if (plan.refersToLoopVariables(current) || plan.refersToLoopVariables(changed)) {
      refuse(s"$name refers to loop variables, so it can't be changed while the workflow runs.")
    }
    // An operator that offers to be changed while it runs, and overrides nothing to take a
    // change, is left with LogicalOp's own runtimeReconfiguration, which throws rather than
    // answering a Failure; so does a descriptor that cannot build its operator from the change.
    // Either refuses the change, in the failure's words, or by its type when it has none.
    val reconfigured =
      Try(reconfigure(current, changed, workflowId, executionId)).flatten match {
        case Success((op, _)) => op
        case Failure(failure) => refuse(Option(failure.getMessage).getOrElse(failure.toString))
      }
    // `running` holds the operators the plan runs under the change's id, by their layers.
    val runningOp =
      Option(running)
        .getOrElse(Nil)
        .find { op =>
          reconfigured.id.logicalOpId == operatorId && op.layerName == reconfigured.id.layerName
        }
        .getOrElse {
          refuse(
            s"The change makes $name the operator ${reconfigured.id.logicalOpId.id}-" +
              s"${reconfigured.id.layerName}, which the running workflow does not have."
          )
        }
    // An update gives the running operator a new executor and what its code reads; its workers
    // keep the interpreter they run in, so a change of environment would never take effect. The
    // running operator's environment is as the plan resolved it, whatever its user keeps under
    // its name now: only asking for another is a change of it.
    if (reconfigured.pythonEnvironment.environmentName != runningOp.pythonEnvironment) {
      refuse("The operator's Python environment cannot change while the run is paused.")
    }
    // A version that does not exist or that the user may not read is the change's error.
    val bound =
      try WorkflowCompiler.bindResources(reconfigured, repositories)
      catch { case error: FileNotFoundException => refuse(error.getMessage) }
    Made(
      PhysicalPlanCodec.updateToJson(PhysicalPlanCodec.encodeUpdate(executionId, updateId, bound)),
      sent
    )
  }
}
