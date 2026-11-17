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

import { z } from "zod";
import {
  ConsoleMessageType,
  OperatorState,
  WorkflowExecutionState,
  WorkflowFatalErrorType,
  type ConsoleMessageSummary,
  type IndexedTuple,
  type OperatorExecutionSummary,
  type WebOutputMode,
  type WorkflowExecutionSummary,
  type WorkflowFatalError,
} from "../types/execution";

export interface LogicalLink {
  fromOpId: string;
  fromPortId: { id: number; internal: boolean };
  toOpId: string;
  toPortId: { id: number; internal: boolean };
}

interface LogicalOperator {
  operatorID: string;
  operatorType: string;
  [key: string]: any;
}

export interface LogicalPlan {
  operators: LogicalOperator[];
  links: LogicalLink[];
  opsToViewResult?: string[];
  opsToReuseResult?: string[];
}

function makeWorkflowError(type: WorkflowFatalErrorType, message: string, operatorId: string): WorkflowFatalError {
  const now = Date.now();
  return {
    type: { name: type },
    timestamp: { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1_000_000 },
    message,
    details: "",
    operatorId,
    workerId: "",
  };
}

/**
 * The body of `POST /api/executions` on the Dashboard service (amber's `CreateExecutionRequest`).
 * The Dashboard creates the execution without a computing unit: it checks the user's rights,
 * compiles the workflow for them and stores the plan that the unit is then asked to run.
 */
export interface CreateExecutionRequest {
  wid: number;
  executionName: string;
  // Names what asks for the execution; the Dashboard keeps it with the execution.
  engineVersion: string;
  // The part of the workflow to run: the target operator and what is upstream of it. The agent
  // cuts it from its own graph, so the request names no target for the Dashboard to cut at.
  logicalPlan: LogicalPlan;
  computingUnitId: number;
  // The user's warehouse the run writes into: required while per-user warehouses are enabled,
  // refused while they are disabled.
  warehouseId?: number;
  emailNotificationEnabled: boolean;
}

/** What a create answers with (201, amber's `CreateExecutionResponse`). */
export interface CreatedExecution {
  eid: number;
  // The execution's plan table, which the computing unit starts the execution from.
  planUri: string;
}

/**
 * The body of `POST /api/execution/{eid}/run` on a computing unit (amber's `SyncRunRequest`): run
 * execution `eid`, which the Dashboard created for this unit, from its stored plan. The unit
 * answers with the legacy sync-execution result, which `adaptLegacySyncExecutionResult` reads.
 */
export interface RunExecutionRequest {
  // The execution's plan table, as the create answered it.
  planUri: string;
  // The computing unit the execution was created for: the one asked.
  computingUnitId: number;
  // The operators whose results are answered.
  targetOperatorIds: string[];
  timeoutSeconds: number;
  maxOperatorResultCharLimit: number;
  maxOperatorResultCellCharLimit: number;
}

const createdExecutionSchema = z.object({
  eid: z.number().int().positive(),
  planUri: z.string().min(1),
});

/** The execution that a create's 201 names. Throws when the answer names none. */
export function parseCreatedExecution(input: unknown): CreatedExecution {
  const parsed = createdExecutionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid create-execution response: ${parsed.error.message}`);
  }
  return parsed.data;
}

// A WorkflowFatalError as the Dashboard writes one. Only its message is read: an operator's error
// is listed under the operator's id.
const compileErrorSchema = z.object({ message: z.string() });

// How the Dashboard answers a create it does not serve, whatever the status: `{code, message}`,
// and for a workflow that does not compile (amber's `CreateExecutionFailure`) also the execution
// and the first error of each operator that has one, by the operator's id.
const createFailureSchema = z.object({
  message: z.string(),
  operatorErrors: z.record(compileErrorSchema).optional(),
});

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The ids of `plan`'s operators, each after the operators upstream of it, otherwise in the plan's order. */
function upstreamFirst(plan: Pick<LogicalPlan, "operators" | "links">): string[] {
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
 * The summary of a create of `plan` that the Dashboard did not answer with an execution: any
 * status but 2xx.
 *
 * A workflow that does not compile is a compilation failure, with each operator's error, which
 * names its operator; the Dashboard has recorded the execution as failed. The answer keys the
 * errors by operator, in no order: they are listed in the plan's, an operator before those
 * downstream of it, so that the cause of a chain of errors comes first. Any other answer is an
 * error that names the status and what the Dashboard said: the message of its `{code, message}`,
 * or else the body as it is, such as a proxy's.
 */
export function adaptCreateExecutionFailure(
  status: number,
  statusText: string,
  body: string,
  plan: Pick<LogicalPlan, "operators" | "links">
): WorkflowExecutionSummary {
  const failure = createFailureSchema.safeParse(parseJsonOrUndefined(body));
  const operatorErrors = failure.success ? (failure.data.operatorErrors ?? {}) : {};
  const withErrors = Object.keys(operatorErrors);
  const inPlan = upstreamFirst(plan).filter(operatorId => withErrors.includes(operatorId));
  const others = withErrors.filter(operatorId => !inPlan.includes(operatorId)).sort();
  const compilationErrors = [...inPlan, ...others].map(operatorId =>
    makeWorkflowError(WorkflowFatalErrorType.COMPILATION_ERROR, operatorErrors[operatorId].message, operatorId)
  );
  if (compilationErrors.length > 0) {
    return { state: WorkflowExecutionState.COMPILATION_FAILED, operators: {}, errors: compilationErrors };
  }

  const reason = failure.success ? failure.data.message : body;
  const answer = [`${status} ${statusText}`.trim(), reason.trim()].filter(Boolean).join(" - ");
  return {
    state: WorkflowExecutionState.ERROR,
    operators: {},
    errors: [
      makeWorkflowError(WorkflowFatalErrorType.EXECUTION_FAILURE, `Execution could not be created: ${answer}`, ""),
    ],
  };
}

/**
 * TEMPORARY BACKEND COMPATIBILITY LAYER.
 *
 * The schemas and inferred wire-format types below exist only to validate and
 * convert the backend's current execution response. They MUST NOT be reused
 * outside this file; all other code must use the canonical types from
 * `types/execution`. Remove this compatibility layer once backend execution is
 * refactored to return the canonical model.
 *
 * TypeScript types are erased at runtime, so Zod validates the untrusted JSON
 * response before it enters the canonical agent-service execution model.
 */
// Console messages are auxiliary, so an unrecognized type (a proto value added
// after this mirror, or ScalaPB's "UNRECOGNIZED") must not reject the whole
// response: the type is validated as text and unknown ones are dropped below.
const legacyConsoleMessageSchema = z.object({
  msgType: z.string(),
  title: z.string().default(""),
  message: z.string(),
});

const legacyResultModeSchema = z.enum(["table", "visualization"]);
type LegacyResultMode = z.output<typeof legacyResultModeSchema>;

const legacyResultModeToWebOutputMode = {
  table: { type: "PaginationMode" },
  visualization: { type: "SetSnapshotMode" },
} satisfies Record<LegacyResultMode, WebOutputMode>;

// Only the fields the adapter reads are validated; zod strips the rest
// (inputTuples, inputPortShapes, displayedRows, truncated, warnings), so the
// backend can change them without failing executions.
const legacyOperatorInfoSchema = z.object({
  state: z.string(),
  outputTuples: z.number(),
  resultMode: legacyResultModeSchema,
  result: z.array(z.record(z.unknown())).nullish(),
  totalRowCount: z.number().int().nonnegative().nullish(),
  consoleLogs: z.array(legacyConsoleMessageSchema).nullish(),
  error: z.string().nullish(),
});

const legacySyncExecutionResultSchema = z.object({
  success: z.boolean(),
  state: z.string(),
  operators: z.record(legacyOperatorInfoSchema),
  errors: z.array(z.string()).nullish(),
});

const internalResultKeys = new Set(["__row_index__", "__is_visualization__"]);
const operatorStates = new Set<string>(Object.values(OperatorState));
const workflowStates = new Set<string>(Object.values(WorkflowExecutionState));
const consoleMessageTypes = new Set<string>(Object.values(ConsoleMessageType));

function normalizeOperatorState(state: string): OperatorState {
  return operatorStates.has(state) ? (state as OperatorState) : OperatorState.UNKNOWN;
}

// Keep the legacy boolean at the wire boundary: canonical consumers use state alone,
// so an unclean legacy completion must become an explicit failure state.
function normalizeWorkflowState(state: string, success: boolean): WorkflowExecutionState {
  const normalized = workflowStates.has(state) ? (state as WorkflowExecutionState) : WorkflowExecutionState.UNKNOWN;
  return !success && normalized === WorkflowExecutionState.COMPLETED ? WorkflowExecutionState.FAILED : normalized;
}

function normalizeCellValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function legacyRowToTuple(row: Record<string, unknown>, fallbackIndex: number): IndexedTuple {
  const rowIndexValue = row["__row_index__"];
  if (rowIndexValue !== undefined && (!Number.isInteger(rowIndexValue) || (rowIndexValue as number) < 0)) {
    throw new Error(`Invalid __row_index__ for sampled row ${fallbackIndex}`);
  }
  const rowIndex = rowIndexValue === undefined ? fallbackIndex : (rowIndexValue as number);
  const entries = Object.entries(row).filter(([name]) => !internalResultKeys.has(name));

  return [
    rowIndex,
    {
      schema: {
        attributes: entries.map(([attributeName]) => ({ attributeName, attributeType: "string" })),
      },
      fields: entries.map(([, value]) => normalizeCellValue(value)),
    },
  ];
}

function adaptConsoleMessages(
  consoleLogs: ReadonlyArray<z.output<typeof legacyConsoleMessageSchema>> | null | undefined
): ReadonlyArray<ConsoleMessageSummary> | undefined {
  const messages = (consoleLogs ?? []).flatMap(message =>
    consoleMessageTypes.has(message.msgType) ? [{ ...message, msgType: message.msgType as ConsoleMessageType }] : []
  );
  return messages.length > 0 ? messages : undefined;
}

function adaptOperatorInfo(
  operatorId: string,
  operator: z.output<typeof legacyOperatorInfoSchema>
): OperatorExecutionSummary {
  const resultSummary =
    operator.result == null
      ? undefined
      : {
          resultMode: legacyResultModeToWebOutputMode[operator.resultMode],
          sampleTuples: operator.result.map(legacyRowToTuple),
          totalTuplesCount: operator.totalRowCount ?? operator.outputTuples,
        };

  const consoleMessages = adaptConsoleMessages(operator.consoleLogs);
  const errorMessages = operator.error
    ? [makeWorkflowError(WorkflowFatalErrorType.EXECUTION_FAILURE, operator.error, operatorId)]
    : [];

  return {
    state: normalizeOperatorState(operator.state),
    errorMessages,
    resultSummary,
    consoleMessages,
  };
}

/**
 * Compatibility boundary for the current Scala sync-execution response.
 *
 * The backend is intentionally left on its legacy contract in this change. Its execution
 * result model will be redesigned and refactored separately; remove these legacy schemas
 * and this adapter once that backend work lands.
 */
export function adaptLegacySyncExecutionResult(input: unknown): WorkflowExecutionSummary {
  const parsed = legacySyncExecutionResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid legacy sync-execution response: ${parsed.error.message}`);
  }

  const legacy = parsed.data;
  const operators = Object.fromEntries(
    Object.entries(legacy.operators).map(([operatorId, operator]) => [
      operatorId,
      adaptOperatorInfo(operatorId, operator),
    ])
  );

  // A unit runs a plan the Dashboard compiled, so what it reports is a failure of the run. An error
  // it reports more than once, as when several workers fail alike, is listed once.
  const errors = [...new Set(legacy.errors ?? [])].map(message =>
    makeWorkflowError(WorkflowFatalErrorType.EXECUTION_FAILURE, message, "")
  );

  return {
    state: normalizeWorkflowState(legacy.state, legacy.success),
    operators,
    errors,
  };
}
