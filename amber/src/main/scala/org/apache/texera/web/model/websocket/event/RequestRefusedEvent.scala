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
  * Tells the session that sent a request that the request was not done, and why: it was refused,
  * could not be read, or failed. It says nothing about the run this computing unit holds, which
  * is as it was.
  *
  * @param request the request's type, as its frame names it; None for a frame that names none
  * @param message in words for the user who made the request
  */
case class RequestRefusedEvent(
    request: Option[String],
    @JsonDeserialize(contentAs = classOf[java.lang.Long])
    executionId: Option[Long],
    message: String
) extends TexeraWebSocketEvent
