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

package org.apache.texera.web.service.execution

import org.apache.texera.amber.core.storage.{ExecutionLabel, ExecutionLogStore}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.dao.WorkflowExecutionStatus

/** The status code the API answers for what an execution's log says of it. */
object ExecutionStatus {

  /**
    * The code of `state`, a state a log records: the code a computing unit records for the
    * engine's state of that name.
    *
    * @throws IllegalArgumentException if a log records no such state
    */
  def of(state: String): Short =
    Option
      .when(ExecutionLogStore.States.contains(state))(state)
      .flatMap(WorkflowAggregatedState.fromName)
      .map(maptoStatusCode(_).toShort)
      .getOrElse(
        throw new IllegalArgumentException(s"an execution's log records no state '$state'")
      )

  /**
    * The code of an open execution whose log has `label`, None when it has no log: the code of
    * its newest state. With no log, or a log no state was written to yet, no unit has run it,
    * so it is Created: nothing that asks for runs in progress counts it.
    */
  def ofOpen(label: Option[ExecutionLabel]): Short =
    label.flatMap(_.state).map(of).getOrElse(WorkflowExecutionStatus.Created)
}
