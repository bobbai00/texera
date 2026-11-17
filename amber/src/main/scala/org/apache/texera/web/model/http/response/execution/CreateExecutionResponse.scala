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
  * An execution created by `POST /api/executions` (201): its id, and its plan table, which the
  * computing unit it was created for is to start it from.
  *
  * @param planUri names the plan table to the computing unit. To a client it is opaque: it hands
  *                the text to the unit as it got it, and reads nothing from it.
  */
case class CreateExecutionResponse(eid: Long, planUri: String)
