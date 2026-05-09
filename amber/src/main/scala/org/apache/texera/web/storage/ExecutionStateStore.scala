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

package org.apache.texera.web.storage

import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionBreakpointStore,
  ExecutionConsoleStore,
  ExecutionMetadataStore,
  ExecutionStatsStore
}
import org.apache.texera.web.client.WebAppClient

object ExecutionStateStore {

  /**
    * Persists a workflow's status transition through web-app and returns the
    * mutated metadata store. The jwt is the originating user's bearer token,
    * forwarded so web-app authorizes the write against the same user that
    * started the execution. Pass an empty string to skip the web-app call
    * (used by tests that don't have a live web-app).
    */
  def updateWorkflowState(
      state: WorkflowAggregatedState,
      metadataStore: ExecutionMetadataStore,
      jwt: String
  ): ExecutionMetadataStore = {
    if (jwt.nonEmpty) {
      WebAppClient.updateExecution(
        jwt = jwt,
        eid = metadataStore.executionId,
        status = Some(maptoStatusCode(state)),
        lastUpdateTime = Some(System.currentTimeMillis())
      )
    }
    metadataStore.withState(state)
  }
}

// states that within one execution.
class ExecutionStateStore(val jwt: String = "") {
  val statsStore = new StateStore(ExecutionStatsStore())
  val metadataStore = new StateStore(ExecutionMetadataStore())
  val consoleStore = new StateStore(ExecutionConsoleStore())
  val breakpointStore = new StateStore(ExecutionBreakpointStore())
  val reconfigurationStore = new StateStore(ExecutionReconfigurationStore())

  def getAllStores: Iterable[StateStore[_]] = {
    Iterable(statsStore, consoleStore, breakpointStore, metadataStore, reconfigurationStore)
  }
}
