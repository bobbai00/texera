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

/**
  * What `GET /api/executions/{eid}/state` answers: the state of one execution, from its closing
  * record once it is closed, and from its log while it is open.
  *
  * @param status a code of [[org.apache.texera.dao.WorkflowExecutionStatus]]. Closed: how it
  *               ended. Open: initializing, running or paused, or an ending the closing job has
  *               yet to record; created, when no unit has written a state; unknown (-1) when
  *               the lake cannot be read.
  * @param open   whether the execution has no closing record yet
  * @param reason null unless its closing record or its log gives one
  * @param timeMs when it took that state, in epoch milliseconds: when it ended, once closed;
  *               when it was created, while its log shows no state or cannot be read
  */
case class ExecutionStateResponse(
    eid: Long,
    status: Short,
    open: Boolean,
    reason: Option[String],
    timeMs: Long
)
