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
  /** The execution whose replay log is read. */
  eid: number;
  /** The id of the embedded control message to replay up to. */
  interaction: string;
}>;

/**
 * The body of `POST /api/executions`, as the editor sends it: an execution of workflow `wid` to create, to run
 * on computing unit `computingUnitId`.
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
  wid: number;
  computingUnitId: number;
  planUri: string;
}>;

/**
 * The body of a 400 from `POST /api/executions` for a workflow that does not compile: the execution is
 * recorded as failed. `operatorErrors` holds the first error of each operator that has one, in the order of
 * the workflow (an operator before those downstream of it); `errors` the errors that belong to no operator.
 */
export type CreateExecutionFailure = Readonly<{
  eid: number;
  operatorErrors: Readonly<Record<string, WorkflowFatalError>>;
  errors: ReadonlyArray<WorkflowFatalError>;
}>;

/** A change to a paused operator that `POST /api/executions/{eid}/updates` stored (200). */
export type OperatorUpdateResponse = Readonly<{
  /** The id the computing unit is asked to apply the change by. */
  updateId: string;
  operatorId: string;
}>;

/** How the Dashboard service answers a request it refuses, or fails to serve: the HTTP status, and why. */
type ErrorBody = Readonly<{
  code: number;
  message: string;
}>;

function isCreateExecutionFailure(body: unknown): body is CreateExecutionFailure {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { operatorErrors, errors } = body as Partial<Record<keyof CreateExecutionFailure, unknown>>;
  return (
    typeof operatorErrors === "object" &&
    operatorErrors !== null &&
    !Array.isArray(operatorErrors) &&
    Array.isArray(errors)
  );
}

function isErrorBody(body: unknown): body is ErrorBody {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { code, message } = body as Partial<Record<keyof ErrorBody, unknown>>;
  return typeof code === "number" && typeof message === "string";
}

/**
 * The compile failure that `error`, the failure of a `POST /api/executions`, reports: the workflow does not
 * compile. Undefined for any other failure, whose reason is its {@link failureMessage}.
 */
export function compileFailureOf(error: unknown): CreateExecutionFailure | undefined {
  if (!(error instanceof HttpErrorResponse)) {
    return undefined;
  }
  const body: unknown = error.error;
  return isCreateExecutionFailure(body) ? body : undefined;
}

/**
 * Why a request to the Dashboard service failed, in words for the user: the reason the Dashboard gives
 * (`{code, message}`), or, for an answer that is not its own (a gateway's error page, no answer at all), the
 * failed request as the browser reports it.
 */
export function failureMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) {
    return String(error);
  }
  const body: unknown = error.error;
  return isErrorBody(body) ? body.message : error.message;
}

/**
 * The Dashboard service's executions. An execution is created here, with its plan, and then started on its
 * computing unit by id; a change to one of its operators, while it is paused, is stored here, and then named
 * to the unit by id.
 */
@Injectable({
  providedIn: "root",
})
export class ExecutionApiService {
  constructor(private http: HttpClient) {}

  /**
   * Creates an execution: the Dashboard checks the caller's rights, compiles the workflow for them, records
   * the execution and writes its plan. Fails with the HTTP error: see {@link compileFailureOf} and
   * {@link failureMessage}.
   */
  public create(request: CreateExecutionRequest): Observable<CreateExecutionResponse> {
    return this.http.post<CreateExecutionResponse>(WORKFLOW_EXECUTIONS_API_BASE_URL, request);
  }

  /**
   * Stores `operator`, as the editor holds it once changed, as a change to paused execution `eid`, for its
   * computing unit to apply when the run resumes. Fails with the HTTP error: see {@link failureMessage}.
   */
  public postUpdate(eid: number, operator: LogicalOperator): Observable<OperatorUpdateResponse> {
    return this.http.post<OperatorUpdateResponse>(`${WORKFLOW_EXECUTIONS_API_BASE_URL}/${eid}/updates`, { operator });
  }
}
