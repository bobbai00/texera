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
  * An execution `POST /api/executions` created but could not make a plan for (400): the workflow
  * does not compile. The execution is recorded as failed.
  *
  * Each error is a `WorkflowFatalError` as the compiling service writes its operators' errors
  * (`{type: {name}, timestamp: {seconds, nanos}, message, details, operatorId, workerId}`), so the
  * browser shows them as it shows those.
  *
  * @param eid            the execution, recorded as failed
  * @param operatorErrors the first error of each operator that has one, by the operator's id, in
  *                       the order of the workflow: an operator before those downstream of it
  * @param errors         the errors that belong to no operator. A compile that fails reports
  *                       every error on an operator, so this is empty for now.
  */
case class CreateExecutionFailure(
    eid: Long,
    operatorErrors: Map[String, WorkflowFatalError],
    errors: List[WorkflowFatalError]
)
