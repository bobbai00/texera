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

package org.apache.texera.web.model.http.response.execution

import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError

/**
  * The body of the 400 that `POST /api/executions` answers for a workflow that does not compile:
  * the `code` and `message` of every refusal, and beside them the execution, which is recorded
  * as failed, and its operators' errors.
  *
  * @param operatorErrors the first error of each operator that has one, by the operator's id
  *                       ([[org.apache.texera.common.compiler.WorkflowCompilationFailed]]),
  *                       written as the compiling service writes its operators' errors
  *                       (`{type: {name}, timestamp: {seconds, nanos}, message, details,
  *                       operatorId, workerId}`), so the browser shows them alike. A JSON object
  *                       has no order: a client that lists them orders them itself.
  */
case class CreateExecutionFailure(
    code: Int,
    message: String,
    eid: Long,
    operatorErrors: Map[String, WorkflowFatalError]
)
