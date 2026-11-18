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

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.JsonNode

/**
  * What `GET /api/executions/{eid}/log` answers: the rows of the execution's log, oldest first
  * (none for an execution with no log), and its closing record (null while it is open).
  */
case class ExecutionLogResponse(
    eid: Long,
    entries: Seq[ExecutionLogEntryResponse],
    closing: Option[ExecutionClosingResponse]
)

/**
  * One row of an execution's log: `{"seq", "timeMs", "kind": "state", "state"}`, and, when the
  * row says why the state changed, `"reason"` and `"errors"`.
  *
  * @param timeMs when the engine made the row, in epoch milliseconds on its unit's clock
  * @param errors the run's fatal errors behind the change, each
  *               `{"type", "timeMs", "message", "details", "operatorId", "workerId"}`
  */
@JsonInclude(JsonInclude.Include.NON_ABSENT)
case class ExecutionLogEntryResponse(
    seq: Long,
    timeMs: Long,
    kind: String,
    state: Option[String],
    reason: Option[String],
    errors: Option[JsonNode]
)

/**
  * An execution's closing record.
  *
  * @param outcome   3 completed, 4 failed, 5 killed
  * @param reason    null when the outcome says it all
  * @param endedAtMs in epoch milliseconds
  * @param fromLog   whether the outcome is the ending the execution's log holds; false for a
  *                  verdict the Dashboard service made without one, such as "unit lost"
  */
case class ExecutionClosingResponse(
    outcome: Short,
    reason: Option[String],
    endedAtMs: Long,
    fromLog: Boolean
)
