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

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{PhysicalOp, PhysicalPlanCodec}
import org.apache.texera.amber.operator.{LogicalOp, StateTransferFunc}
import org.apache.texera.common.compiler.model.{LogicalPlan, LogicalPlanPojo}

import scala.util.{Failure, Success, Try}

/**
  * Makes a change to one operator of a paused execution into the operator to run in its place:
  * the change compiled as the execution's plan was, for the user who created the execution, as
  * the text [[PhysicalPlanCodec]] writes an operator's update in.
  *
  * The workflow compiling service makes it, for the Dashboard service to hand to the client, which
  * hands it to the computing unit running the execution. Nothing a compile finds for a run but the
  * datasets and models a change names is found for a change: an operator that takes a change
  * while it runs reads no file and no listing. Whether the change fits the operator the unit
  * runs, of the same layer and in the same Python environment, is the unit's to check.
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
    * Makes `changed` into the operator that takes the place of the operator of its id in
    * execution `executionId`, written as [[PhysicalPlanCodec.updateToJson]] writes an update.
    *
    * The change must keep the operator's type, refer to no loop variable, be one the operator
    * takes while it runs, and name only datasets and models `repositories` pins.
    *
    * @param workflow     the workflow the execution ran, as the editor held it before the
    *                     change; it may hold more than the part the execution ran
    * @param changed      the operator as the editor holds it once changed, under the id it has
    *                     in `workflow`
    * @param repositories pins the dataset and model versions the change names, for the user who
    *                     created the execution ([[WorkflowCompiler.bindResources]])
    * @throws NoSuchOperator  if `workflow` has no operator of the change's id
    * @throws WorkflowRefused if the change names no operator by an id, `workflow` is not a graph
    *                         the compiler reads, or the change is not one the running operator
    *                         can take, with why
    */
  def make(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      workflow: LogicalPlanPojo,
      changed: LogicalOp,
      repositories: RepositoryVersionResolver,
      reconfigure: Reconfigure = byTheOperator
  ): String = {
    def refuse(message: String): Nothing = throw new WorkflowRefused(message)
    if (changed == null) refuse("The request names no operator.")
    val operatorId = changed.operatorIdentifier
    if (Option(operatorId.id).forall(_.isBlank)) refuse("The operator to change has no id.")
    if (workflow == null) refuse("The request holds no workflow to make the change in.")
    workflow.graphProblem().foreach(refuse)
    val plan = LogicalPlan(workflow)
    val current = plan.operators.find(_.operatorIdentifier == operatorId).getOrElse {
      throw new NoSuchOperator(
        s"Operator ${operatorId.id} is not in the workflow sent with the change."
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
    if (reconfigured.id.logicalOpId != operatorId) {
      refuse(
        s"The change makes $name the operator ${reconfigured.id.logicalOpId.id}, not one of " +
          s"operator ${operatorId.id}."
      )
    }
    // A version that does not exist or that the user may not read is the change's error.
    val bound =
      try WorkflowCompiler.bindResources(reconfigured, repositories)
      catch { case error: FileNotFoundException => refuse(error.getMessage) }
    PhysicalPlanCodec.updateToJson(PhysicalPlanCodec.encodeUpdate(executionId, bound))
  }
}
