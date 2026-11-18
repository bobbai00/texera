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

package org.apache.texera.dao

/**
  * The codes of an execution's status. No column holds a status: a closed execution's is the
  * outcome of its closing record (`workflow_executions.outcome`, one of [[Ended]]), and an open
  * one's is read from its log in the lake (`OpenExecutionStatuses` in the Dashboard service).
  * They live beside the table because every service that tells a status needs them. The frontend
  * names them in `frontend/src/app/dashboard/type/workflow-executions-entry.ts`.
  */
object WorkflowExecutionStatus {

  /**
    * The Dashboard service created the execution, and no computing unit has started it. It may
    * never be started: nothing that asks for runs in progress counts it.
    */
  val Created: Short = 6

  /** A computing unit has started the execution and is setting its run up. */
  val Initializing: Short = 0
  val Running: Short = 1
  val Paused: Short = 2
  val Completed: Short = 3
  val Failed: Short = 4
  val Killed: Short = 5

  /** A state of a run that has no code of its own, such as pausing or resuming. */
  val Unknown: Short = -1

  val Ended: Set[Short] = Set(Completed, Failed, Killed)
}
