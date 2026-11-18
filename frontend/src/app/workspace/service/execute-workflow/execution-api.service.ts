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

import { Injectable } from "@angular/core";
import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { Observable } from "rxjs";
import { WorkflowSettings } from "../../../common/type/workflow";
import { WORKFLOW_EXECUTIONS_API_BASE_URL } from "../../../dashboard/service/user/workflow-executions/workflow-executions.service";
import { LogicalOperator, LogicalPlan } from "../../types/execute-workflow.interface";
import { WorkflowFatalError } from "../../types/workflow-websocket.interface";

/** The replay log of an earlier execution of the workflow, replayed up to one interaction. */
export type ReplayExecutionInfo = Readonly<{
  eid: number;
  /** The id of the embedded control message to replay up to. */
  interaction: string;
}>;

/**
 * The body of `POST /api/executions`, as the editor sends it (amber's `CreateExecutionRequest`).
 *
 * The route also takes `targetOperatorId`, which the editor leaves out: for a run up to an operator it sends
 * only the part of the workflow that run needs.
 */
export type CreateExecutionRequest = Readonly<{
  wid: number;
  /** Empty, the execution keeps the default name. */
  executionName: string;
  /** The version of the frontend that asks for the execution, kept with it. */
  engineVersion: string;
  logicalPlan: LogicalPlan;
  workflowSettings: WorkflowSettings;
  /** Whether the run emails its user when it ends or pauses. */
  emailNotificationEnabled: boolean;
  computingUnitId: number;
  /** The warehouse the run writes into: required while per-user warehouses are enabled, refused while not. */
  warehouseId?: number;
  /** The replay log the run replays; left out, it replays none. */
  replayFromExecution?: ReplayExecutionInfo;
}>;

/** An execution `POST /api/executions` created (201): the unit is to start it from its plan table, `planUri`. */
export type CreateExecutionResponse = Readonly<{
  eid: number;
  planUri: string;
}>;

/** A change to a paused operator that `POST /api/executions/{eid}/updates` stored (201). */
export type OperatorUpdateResponse = Readonly<{
  /** The id the computing unit is asked to apply the change by. */
  updateId: string;
  operatorId: string;
}>;

/**
 * How `GET /api/executions/{eid}/state` answers: the state the Dashboard service holds of execution `eid`. While
 * the execution is open, the state its computing unit recorded last; once it is closed, how it ended.
 */
export type ExecutionStateResponse = Readonly<{
  eid: number;
  /**
   * The state as the execution history numbers it: 0 initializing, 1 running, 2 paused, 3 completed, 4 failed,
   * 5 killed, 6 created and started by no unit yet; -1 when the stored state could not be read.
   */
  status: number;
  /** Whether the execution can still change state: false once the Dashboard service has closed it. */
  open: boolean;
  /** Why the execution is in this state, when there is a reason to give: "unit lost", an error's message. */
  reason?: string | null;
  /** When the execution entered this state, or ended, in milliseconds since the epoch. */
  timeMs: number;
}>;

/**
 * How the Dashboard service answers a request it does not serve: the HTTP status, and why. When the workflow
 * of a `POST /api/executions` does not compile (400, amber's `CreateExecutionFailure`), also the execution,
 * which is recorded as failed, and the first error of each operator that has one, by the operator's id.
 */
type ErrorBody = Readonly<{
  code: number;
  message: string;
  eid?: number;
  operatorErrors?: Readonly<Record<string, WorkflowFatalError>>;
}>;

function isErrorBody(body: unknown): body is ErrorBody {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { code, message, operatorErrors } = body as Partial<Record<keyof ErrorBody, unknown>>;
  return (
    typeof code === "number" &&
    typeof message === "string" &&
    (operatorErrors === undefined ||
      (typeof operatorErrors === "object" && operatorErrors !== null && !Array.isArray(operatorErrors)))
  );
}

/** How the Dashboard answered the request that failed with `error`, if the answer is one of its own. */
function errorBodyOf(error: unknown): ErrorBody | undefined {
  if (!(error instanceof HttpErrorResponse)) {
    return undefined;
  }
  const body: unknown = error.error;
  return isErrorBody(body) ? body : undefined;
}

/** The ids of `plan`'s operators, each after the operators upstream of it, otherwise in the plan's order. */
function upstreamFirst(plan: LogicalPlan): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const place = (operatorId: string): void => {
    if (ordered.includes(operatorId) || visiting.has(operatorId)) {
      return;
    }
    visiting.add(operatorId);
    plan.links.filter(link => link.toOpId === operatorId).forEach(link => place(link.fromOpId));
    visiting.delete(operatorId);
    ordered.push(operatorId);
  };
  plan.operators.forEach(operator => place(operator.operatorID));
  return ordered;
}

/**
 * The operators' errors that `error`, the failure of a `POST /api/executions` of `plan`, reports: the
 * workflow does not compile. They are listed in the order of the plan, an operator before those downstream
 * of it, so that the cause of a chain of errors comes first: the answer keys them by operator, in no order.
 * Undefined for any other failure, whose reason is its {@link failureMessage}.
 */
export function operatorErrorsOf(error: unknown, plan: LogicalPlan): ReadonlyArray<WorkflowFatalError> | undefined {
  const operatorErrors = errorBodyOf(error)?.operatorErrors;
  if (operatorErrors === undefined) {
    return undefined;
  }
  const withErrors = Object.keys(operatorErrors);
  const inPlan = upstreamFirst(plan).filter(operatorId => withErrors.includes(operatorId));
  const others = withErrors.filter(operatorId => !inPlan.includes(operatorId)).sort();
  return [...inPlan, ...others].map(operatorId => operatorErrors[operatorId]);
}

/**
 * Why a request to the Dashboard service failed, in words for the user: the reason the Dashboard gives
 * (`{code, message}`), or, for an answer that is not its own (a gateway's error page, no answer at all), what
 * became of the request.
 */
export function failureMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) {
    return String(error);
  }
  const answer = errorBodyOf(error);
  if (answer !== undefined) {
    return answer.message;
  }
  switch (error.status) {
    case 0:
      return "The Dashboard service could not be reached.";
    case 413:
      return "The workflow is larger than this deployment accepts in one request.";
    default:
      return `The Dashboard service answered ${error.status} ${error.statusText}.`;
  }
}

/**
 * The Dashboard service's executions. An execution is created here, with its plan, and then started on its
 * computing unit by id; a change to one of its operators, while it is paused, is stored here, and then named
 * to the unit by id. Its state is kept here too, for a page whose computing unit does not show its run.
 *
 * Each call fails with the HTTP error: see {@link failureMessage} and, for a create, {@link operatorErrorsOf}.
 */
@Injectable({
  providedIn: "root",
})
export class ExecutionApiService {
  constructor(private http: HttpClient) {}

  public create(request: CreateExecutionRequest): Observable<CreateExecutionResponse> {
    return this.http.post<CreateExecutionResponse>(WORKFLOW_EXECUTIONS_API_BASE_URL, request);
  }

  /** Stores `operator`, as the editor holds it once changed, as a change to paused execution `eid`. */
  public postUpdate(eid: number, operator: LogicalOperator): Observable<OperatorUpdateResponse> {
    return this.http.post<OperatorUpdateResponse>(`${WORKFLOW_EXECUTIONS_API_BASE_URL}/${eid}/updates`, { operator });
  }

  public getState(eid: number): Observable<ExecutionStateResponse> {
    return this.http.get<ExecutionStateResponse>(`${WORKFLOW_EXECUTIONS_API_BASE_URL}/${eid}/state`);
  }
}
