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

package org.apache.texera.web.model.websocket.event

import com.fasterxml.jackson.databind.annotation.JsonDeserialize

/**
  * The state of the run of a workflow that this computing unit holds, as a session on the
  * workflow is told it when it opens and each time the state changes.
  *
  * @param executionId the execution the run is of, so a session that did not start the run knows
  *                    which execution it watches; None when the state is of no run
  */
case class WorkflowStateEvent(
    state: String,
    @JsonDeserialize(contentAs = classOf[java.lang.Long])
    executionId: Option[Long]
) extends TexeraWebSocketEvent
