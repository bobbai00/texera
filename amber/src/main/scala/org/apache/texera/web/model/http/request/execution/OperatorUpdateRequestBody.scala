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

package org.apache.texera.web.model.http.request.execution

import org.apache.texera.amber.operator.LogicalOp

/**
  * The body of `POST /api/executions/{eid}/updates`: a change to one operator of a paused
  * execution.
  *
  * @param operator the operator as the editor holds it once changed, under the id it has in the
  *                 workflow the execution runs
  */
case class OperatorUpdateRequestBody(operator: LogicalOp)
