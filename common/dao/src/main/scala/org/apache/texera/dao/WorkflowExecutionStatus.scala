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
  * The codes `workflow_executions.status` holds. They live beside the table because every service
  * that reads or writes the column needs them: the Dashboard service, the computing units and the
  * computing unit manager. The frontend names them in
  * `frontend/src/app/dashboard/type/workflow-executions-entry.ts`.
  */
object WorkflowExecutionStatus {

  /** A computing unit is setting the execution's run up. */
  val Initializing: Short = 0
  val Running: Short = 1
  val Paused: Short = 2
  val Completed: Short = 3
  val Failed: Short = 4
  val Killed: Short = 5

  /** A state of a run that has no code of its own, such as pausing or resuming. */
  val Unknown: Short = -1

  /** The codes of an execution that has ended. */
  val Ended: Set[Short] = Set(Completed, Failed, Killed)
}
