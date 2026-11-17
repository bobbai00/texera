/**
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
import { ExecutionState } from "../../workspace/types/execute-workflow.interface";

export interface WorkflowExecutionsEntry {
  eId: number;
  vId: number;
  cuId: number;
  /** null for runs on the shared default storage, and after the warehouse is deleted. */
  whId: number | null;
  sId: number;
  userName: string;
  avatar: string;
  name: string;
  startingTime: number;
  completionTime: number;
  status: number;
  result: string;
  bookmarked: boolean;
  logLocation: string;
}

/**
 * The status of an execution that the Dashboard service created and no computing unit has started. It is not
 * a state of a run, so it is no ExecutionState: such an execution may never be started, and nothing that asks
 * for runs counts it.
 */
export const CREATED_EXECUTION_STATUS = 6;

export const EXECUTION_STATUS_CODE: Record<number, string> = {
  0: ExecutionState.Initializing,
  1: ExecutionState.Running,
  2: ExecutionState.Paused,
  3: ExecutionState.Completed,
  4: ExecutionState.Failed,
  5: ExecutionState.Killed,
  [CREATED_EXECUTION_STATUS]: "Created",
};
