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
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity
}

import java.net.URI

/**
  * An execution as the engine is given it to run: the physical plan, the context it runs under,
  * and what else the run needs that the plan does not hold. [[PhysicalPlanCodec]] saves it and
  * reads it back.
  *
  * @param context   the run's ids, settings, warehouse and cost hints
  * @param plan      the physical plan, made to run
  * @param replay    where the run replays from; None when it replays nothing
  * @param replayLog where the run writes its replay log, an absolute URI; None when it writes none
  * @param inputs    what the operators read from outside the run, each (operator, name) once. A
  *                  saved plan lists them in the order of the operator's id, then the name.
  */
final case class ExecutionPlan(
    context: WorkflowContext,
    plan: PhysicalPlan,
    replay: Option[ReplaySource] = None,
    replayLog: Option[URI] = None,
    inputs: Seq[PlanInput] = Seq.empty
)

/**
  * The replay log an earlier execution wrote, read up to one interaction.
  *
  * @param sourceExecutionId the execution that wrote the log
  * @param logLocation       where the log is, an absolute URI
  * @param interaction       the id of the embedded control message to replay up to
  */
final case class ReplaySource(
    sourceExecutionId: ExecutionIdentity,
    logLocation: URI,
    interaction: String
)

/**
  * How long each logical operator took in an earlier execution of the workflow, for the
  * scheduler's cost model. It may name operators the plan no longer has.
  *
  * @param sourceExecutionId        the execution the costs were measured in
  * @param secondsByLogicalOperator the seconds each logical operator, by its id, took
  */
final case class CostHints(
    sourceExecutionId: ExecutionIdentity,
    secondsByLogicalOperator: Map[String, Double]
)

/**
  * A file a logical operator of the plan reads from outside the run, through a link made when the
  * plan was made.
  *
  * @param logicalOperatorId the operator that reads it
  * @param name              the name the operator's executor knows it by
  * @param expiresAtMs       when the link stops working, in milliseconds since the epoch
  */
final case class PlanInput(logicalOperatorId: OperatorIdentity, name: String, expiresAtMs: Long)

/**
  * A change to one operator of a paused run, which the engine applies when the run resumes: the
  * operator's new executor, and what its new code reads. The rest of the operator, its ports and
  * links included, stays as the running plan has it.
  *
  * @param executionId      the execution whose operator changes
  * @param updateId         names the change among the execution's changes
  * @param opId             the operator that changes
  * @param opExecInitInfo   the operator's new executor
  * @param repositoryMounts the datasets and models the new code reads, under the root it reads
  *                         them from; None when it reads none
  */
final case class OperatorUpdate(
    executionId: ExecutionIdentity,
    updateId: String,
    opId: PhysicalOpIdentity,
    opExecInitInfo: OpExecInitInfo,
    repositoryMounts: Option[RepositoryMounts]
)
