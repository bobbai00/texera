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
  * What `GET /api/executions/{eid}/console` answers: one page of the console output the
  * execution stored, oldest first.
  *
  * @param messages empty for an execution that stored no console output, and for one whose
  *                 results have expired, its console output with them
  * @param lastSeq  the `afterSeq` of the next page: the `seq` of the page's last message, or the
  *                 `afterSeq` that was asked for when the page is empty
  */
case class ExecutionConsoleResponse(
    eid: Long,
    messages: Seq[ExecutionConsoleMessageResponse],
    lastSeq: Long,
    more: Boolean
)

/**
  * One console message, whole: what the live view shortens is stored unshortened.
  *
  * @param seq        1, 2, 3, … in the order the engine received the execution's messages
  * @param timeMs     the message's own time, in epoch milliseconds
  * @param operatorId a logical operator's id; empty for the engine's note that messages were
  *                   not stored
  * @param msgType    `PRINT`, `ERROR`, `COMMAND` or `DEBUGGER`
  */
case class ExecutionConsoleMessageResponse(
    seq: Long,
    timeMs: Long,
    operatorId: String,
    workerId: String,
    msgType: String,
    source: String,
    title: String,
    message: String
)
