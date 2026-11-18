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

package org.apache.texera.web.model.http.request.execution

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import org.apache.texera.amber.core.workflow.WorkflowSettings

/**
  * The replay log of earlier execution `eid` of the workflow, read up to `interaction`, the id of
  * an embedded control message.
  */
case class ReplayExecutionInfo(
    @JsonDeserialize(contentAs = classOf[java.lang.Long])
    eid: Long,
    interaction: String
)

/**
  * The body of `POST /api/executions`: an execution of workflow `wid` to create, to run on
  * computing unit `computingUnitId`.
  *
  * @param executionName    empty for the default name
  * @param engineVersion    the version of the frontend or agent that asks for the execution,
  *                         kept with it
  * @param logicalPlan      the workflow as the editor holds it. The Dashboard hands it to the
  *                         compiling service as it is, and reads nothing in it.
  * @param workflowSettings None for the defaults. The output ports whose results are stored are
  *                         the compiler's to find, so any sent here are ignored.
  * @param warehouseId      the user_warehouse row the run writes into: required while per-user
  *                         warehouses are enabled, refused while they are disabled
  *                         ([[org.apache.texera.web.service.execution.ExecutionWarehouse]])
  * @param targetOperatorId the operator the run executes up to ("Execute To"): only it and the
  *                         operators upstream of it are compiled. None for the whole workflow.
  */
case class CreateExecutionRequest(
    wid: Long,
    executionName: String = "",
    engineVersion: String,
    logicalPlan: JsonNode,
    workflowSettings: Option[WorkflowSettings],
    emailNotificationEnabled: Boolean = false,
    computingUnitId: Int,
    @JsonDeserialize(contentAs = classOf[java.lang.Integer])
    warehouseId: Option[Int],
    replayFromExecution: Option[ReplayExecutionInfo],
    targetOperatorId: Option[String] = None
)
