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

package org.apache.texera.amber.core.workflow

import org.apache.texera.amber.core.executor.OpExecInitInfo
import org.apache.texera.amber.core.storage.VFSURIFactory
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, PhysicalOpIdentity}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode

import java.net.URI

/**
  * An execution as the engine is given it to run. A plan made to run holds everything the
  * computing unit that runs it needs, so the unit asks no service while it runs the plan.
  * [[PhysicalPlanCodec]] saves it and reads it back.
  *
  * @param replayLog where the run writes its replay log, an absolute URI
  */
final case class ExecutionPlan(
    context: WorkflowContext,
    plan: PhysicalPlan,
    replay: Option[ReplaySource] = None,
    replayLog: Option[URI] = None
) {

  /**
    * The tables the run writes the results the workflow keeps into: one for each output port the
    * settings store the results of ([[WorkflowSettings.outputPortsNeedingStorage]]), at the
    * location the plan names for the port, as the engine makes them. Ports the engine stores only
    * to schedule the run are not among them. In the order of their operators and ports.
    */
  def resultTables: Seq[ResultTable] =
    context.workflowSettings.outputPortsNeedingStorage.toSeq
      .map { port =>
        val op = plan.getOperator(port.opId)
        ResultTable(
          port,
          VFSURIFactory.resultURI(op.storageLocation(port.portId)),
          op.outputPorts(port.portId)._1.mode
        )
      }
      .sortBy(table =>
        (table.port.opId.logicalOpId.id, table.port.opId.layerName, table.port.portId.id)
      )
}

/**
  * The table an execution writes the result of an output port into, and how the port writes it.
  */
final case class ResultTable(port: GlobalPortIdentity, uri: URI, mode: OutputMode)

/**
  * The replay log an earlier execution wrote, read up to one interaction.
  *
  * @param logLocation where the log is, an absolute URI
  * @param interaction the id of the embedded control message to replay up to
  */
final case class ReplaySource(
    sourceExecutionId: ExecutionIdentity,
    logLocation: URI,
    interaction: String
)

/**
  * How long each logical operator, by its id, took in an earlier execution of the workflow, for
  * the scheduler's cost model. It may name operators the plan no longer has.
  */
final case class CostHints(
    sourceExecutionId: ExecutionIdentity,
    secondsByLogicalOperator: Map[String, Double]
)

/**
  * A change to one operator of a paused run, which the engine applies when the run resumes: the
  * operator's new executor, and what its new code reads. The rest of the operator, its ports and
  * links included, stays as the running plan has it.
  *
  * @param repositoryMounts  the datasets and models the new code reads; None when it reads none
  * @param pythonEnvironment the name of the Python environment the changed operator asks to run
  *                          in; None for the engine's own. Its workers keep the interpreter they
  *                          run in, so the engine refuses a change that asks for another.
  */
final case class OperatorUpdate(
    executionId: ExecutionIdentity,
    opId: PhysicalOpIdentity,
    opExecInitInfo: OpExecInitInfo,
    repositoryMounts: Option[RepositoryMounts],
    pythonEnvironment: Option[String]
)
