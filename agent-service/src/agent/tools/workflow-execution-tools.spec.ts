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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { executeOperatorAndFormat, createExecuteOperatorTool, type ExecutionConfig } from "./workflow-execution-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { getBackendConfig } from "../../api/backend-api";
import { env } from "../../config/env";
import {
  ConsoleMessageType,
  OperatorState,
  WorkflowExecutionState,
  WorkflowFatalErrorType,
  type OperatorExecutionSummary,
  type Tuple,
  type WorkflowExecutionSummary,
  type WorkflowFatalError,
} from "../../types/execution";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";

// --- fixtures -------------------------------------------------------------

// Build an engine-style Tuple (all-STRING schema) from a column->value record.
function recordToTuple(row: Record<string, unknown>): Tuple {
  return {
    schema: { attributes: Object.keys(row).map(name => ({ attributeName: name, attributeType: "string" })) },
    fields: Object.values(row),
  };
}

function makeOperator(id: string, overrides: Partial<OperatorPredicate> = {}): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: "TestOp",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [{ portID: "out-0" }],
    showAdvanced: false,
    ...overrides,
  };
}

function makeLink(source: string, sourcePort: string, target: string, targetPort: string): OperatorLink {
  return {
    linkID: `${source}.${sourcePort}->${target}.${targetPort}`,
    source: { operatorID: source, portID: sourcePort },
    target: { operatorID: target, portID: targetPort },
  };
}

function makeState(...operators: OperatorPredicate[]): WorkflowState {
  const state = new WorkflowState();
  for (const op of operators) state.addOperator(op);
  return state;
}

// A valid two-operator DAG: src (no inputs) --> tgt (one required input).
function makeLinearState(): { state: WorkflowState; source: string; target: string } {
  const source = "src";
  const target = "tgt";
  const state = makeState(
    makeOperator(source),
    makeOperator(target, { inputPorts: [{ portID: "in-0", disallowMultiInputs: true }] })
  );
  state.addLink(makeLink(source, "out-0", target, "in-0"));
  return { state, source, target };
}

// The user every run below is for, and a token that names them: only its payload is read here.
const USER_ID = 9;
const USER_TOKEN = `header.${Buffer.from(JSON.stringify({ userId: USER_ID, sub: "ada" })).toString("base64")}.signature`;

function makeConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return { userToken: USER_TOKEN, workflowId: 1, ...overrides };
}

function makeFatal(message: string): WorkflowFatalError {
  return {
    type: { name: WorkflowFatalErrorType.EXECUTION_FAILURE },
    timestamp: { seconds: 0, nanos: 0 },
    message,
    details: "",
    operatorId: "",
    workerId: "",
  };
}

// --- fetch / metadata stubbing -------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>;
let validateSpy: ReturnType<typeof spyOn>;

// An execution is created at the Dashboard service, which has its computing unit start it; the
// unit is then asked to wait for it.
const { apiEndpoint: DASHBOARD, executionEndpoint: UNIT } = getBackendConfig();
const CREATE_URL = `${DASHBOARD}/api/executions`;

// What the Dashboard answers a create with, unless a test says otherwise, and the wait for it.
const CREATED = { eid: 345 };
const WAIT_URL = `${UNIT}/api/execution/345/wait`;

function createdResponse(body: unknown = CREATED): Response {
  return new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } });
}

// A create the Dashboard refuses: `{code, message}`.
function refusedResponse(status: number, statusText: string, message: string): Response {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

// A create of a workflow that does not compile: the execution the Dashboard recorded as failed,
// each operator's error, a WorkflowFatalError, under the operator's id, and the errors of no
// operator after them.
function compileFailureResponse(messageByOperator: Record<string, string>): Response {
  const compileError = (message: string, operatorId: string) => ({
    type: { name: "COMPILATION_ERROR" },
    timestamp: { seconds: 1794873600, nanos: 0 },
    message,
    details: `${message}\n\tat org.apache.texera.common.compiler.WorkflowCompiler.compile`,
    operatorId,
    workerId: "",
  });
  const operatorErrors = Object.fromEntries(
    Object.entries(messageByOperator).map(([operatorId, message]) => [operatorId, compileError(message, operatorId)])
  );
  const count = Object.keys(operatorErrors).length;
  return new Response(
    JSON.stringify({
      code: 400,
      message: `The workflow does not compile: ${count} operators have errors.`,
      eid: 345,
      operatorErrors,
    }),
    { status: 400, statusText: "Bad Request", headers: { "Content-Type": "application/json" } }
  );
}

// Answers the create with `create`, and a wait for an execution with `wait`. Any other request
// fails loudly: a wait when `wait` is absent, and every other route of a unit, none of which
// starts an execution for a client.
function routeFetch(create: Response, wait?: Response | Error): void {
  fetchSpy.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url === CREATE_URL) return create;
    if (wait !== undefined && /\/api\/execution\/\d+\/wait$/.test(url)) {
      if (wait instanceof Error) throw wait;
      return wait;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// The Dashboard creates and starts the execution, and the unit's wait for it answers `value`.
function setFetchResolving(value: Response): void {
  routeFetch(createdResponse(), value);
}

// Every request fails, so the create does.
function setFetchRejecting(error: Error): void {
  fetchSpy.mockRejectedValue(error);
}

// The URLs requested so far, in order.
function requestUrls(): string[] {
  return fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

// The JSON body of the nth request: an execution's create comes first (0), then the wait for it (1).
function requestBody(callIndex = 0): any {
  return JSON.parse((fetchSpy.mock.calls[callIndex][1] as RequestInit).body as string);
}

// The headers of the nth request.
function requestHeaders(callIndex = 0): Record<string, string> {
  return (fetchSpy.mock.calls[callIndex][1] as RequestInit).headers as Record<string, string>;
}

// Project a canonical summary onto the backend's legacy wire JSON, which is what
// fetch still returns and what `adaptLegacySyncExecutionResult` converts back.
function toLegacyResponse(summary: WorkflowExecutionSummary) {
  return {
    success: summary.state === WorkflowExecutionState.COMPLETED,
    state: summary.state,
    operators: Object.fromEntries(
      Object.entries(summary.operators).map(([operatorId, operator]) => {
        const resultSummary = operator.resultSummary;
        const error =
          operator.errorMessages
            .map(item => item.message)
            .filter(Boolean)
            .join("; ") || undefined;
        const result = resultSummary?.sampleTuples.map(([rowIndex, tuple]) => ({
          __row_index__: rowIndex,
          ...Object.fromEntries(
            tuple.schema.attributes.map((attribute, index) => [attribute.attributeName, tuple.fields[index]])
          ),
        }));

        return [
          operatorId,
          {
            state: operator.state,
            inputTuples: 0,
            outputTuples: resultSummary?.totalTuplesCount ?? 0,
            resultMode: resultSummary?.resultMode.type === "SetSnapshotMode" ? "visualization" : "table",
            result,
            totalRowCount: resultSummary?.totalTuplesCount,
            consoleLogs: operator.consoleMessages ? [...operator.consoleMessages] : undefined,
            error,
          },
        ];
      })
    ),
    errors: summary.errors.map(error => error.message),
  };
}

// An ok Response carrying raw legacy wire JSON (for legacy-only fields the canonical model lacks).
function legacyJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponse(summary: WorkflowExecutionSummary): Response {
  return legacyJsonResponse(toLegacyResponse(summary));
}

// Invoke the AI-SDK tool's execute without constructing full ToolCallOptions.
function runTool(executeTool: ReturnType<typeof createExecuteOperatorTool>, operatorId: string): Promise<string> {
  return (executeTool.execute as (a: { operatorId: string }, o: object) => Promise<string>)({ operatorId }, {});
}

beforeEach(() => {
  // Default: any unexpected network call fails loudly instead of hitting localhost.
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  // Default: every operator's schema validates, so validation never short-circuits.
  validateSpy = spyOn(WorkflowSystemMetadata.getInstance(), "validateOperatorProperties").mockReturnValue({
    isValid: true,
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  validateSpy.mockRestore();
});

// --- tests ----------------------------------------------------------------

describe("executeOperatorAndFormat - pre-flight guards", () => {
  test("returns an error when the workflow is empty", async () => {
    const out = await executeOperatorAndFormat(new WorkflowState(), makeConfig(), "missing");
    expect(out).toBe("[ERROR] Cannot execute: workflow has no operators.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns an error when the target operator is absent from a non-empty workflow", async () => {
    // The sub-DAG built for a non-existent target contains no operators.
    const out = await executeOperatorAndFormat(makeState(makeOperator("other")), makeConfig(), "missing");
    expect(out).toBe("[ERROR] Cannot execute: workflow has no operators.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blocks on the target operator's schema validation errors", async () => {
    const { state, target } = makeLinearState();
    validateSpy.mockReturnValue({ isValid: false, messages: { attributeName: "must not be empty" } });

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toBe(`[ERROR] Operator ${target}:\n  - attributeName: must not be empty`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("merges schema and connection violations into one blocking message", async () => {
    validateSpy.mockReturnValue({ isValid: false, messages: { limit: "must be a number" } });
    const state = makeState(makeOperator("solo", { inputPorts: [{ portID: "in-0" }] }));

    const out = await executeOperatorAndFormat(state, makeConfig(), "solo");
    expect(out).toBe(
      "[ERROR] Operator solo:\n  - limit: must be a number\n  - inputs: in-0 requires at least 1 input, has 0."
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blocks when a disallow-multi-input port has no incoming link", async () => {
    const state = makeState(makeOperator("solo", { inputPorts: [{ portID: "in-0", disallowMultiInputs: true }] }));

    const out = await executeOperatorAndFormat(state, makeConfig(), "solo");
    expect(out).toBe("[ERROR] Operator solo:\n  - inputs: in-0 requires 1 input, has 0.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blocks when a regular input port has no incoming link", async () => {
    const state = makeState(makeOperator("solo", { inputPorts: [{ portID: "in-0" }] }));

    const out = await executeOperatorAndFormat(state, makeConfig(), "solo");
    expect(out).toBe("[ERROR] Operator solo:\n  - inputs: in-0 requires at least 1 input, has 0.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects a single-input port that has more than one incoming link, naming it by display name", async () => {
    const dst = makeOperator("dst", {
      inputPorts: [{ portID: "in-0", displayName: "Left", disallowMultiInputs: true }],
    });
    const state = makeState(makeOperator("a"), makeOperator("b"), dst);
    state.addLink(makeLink("a", "out-0", "dst", "in-0"));
    state.addLink(makeLink("b", "out-0", "dst", "in-0"));

    const out = await executeOperatorAndFormat(state, makeConfig(), "dst");
    expect(out).toBe("[ERROR] Operator dst:\n  - inputs: Left requires 1 input, has 2.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("executeOperatorAndFormat - successful runs", () => {
  test("renders the shape, warnings, gaps, and every cell type", async () => {
    const { state, source, target } = makeLinearState();

    const sampleTuples: [number, Tuple][] = [
      [
        0,
        recordToTuple({
          num: 1,
          bool: true,
          str: "hello",
          nil: null,
          nullstr: "NULL",
          escaped: "a\tb\nc",
          obj: { k: 1 },
        }),
      ],
      [
        3, // gap after 0 -> a "..." separator row is inserted
        recordToTuple({
          num: 2,
          bool: false,
          str: "world",
          nil: null,
          nullstr: "kept",
          escaped: "plain",
          obj: [1, 2],
        }),
      ],
    ];

    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: { resultMode: { type: "PaginationMode" }, sampleTuples, totalTuplesCount: 10 },
          consoleMessages: [
            { msgType: ConsoleMessageType.PRINT, title: "WARNING: truncated output", message: "" },
            { msgType: ConsoleMessageType.PRINT, title: "just info, not a warning", message: "" },
          ],
        },
        [source]: { state: OperatorState.COMPLETED, errorMessages: [] },
        // An errored sibling: the notify loop must skip it (covers the false branch).
        ghost: { state: OperatorState.FAILED, errorMessages: [makeFatal("ignored")] },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = mock(() => {});
    const out = await executeOperatorAndFormat(state, makeConfig(), target, { onResult });

    expect(out).toContain(`Executed operator ${target}`);
    expect(out).toContain("Output table shape: (10, 7)");
    expect(out).toContain("WARNING: truncated output");
    expect(out).not.toContain("just info");
    expect(out).toContain("NaN"); // null cell
    expect(out).toContain("a\\tb\\nc"); // tab/newline escaped
    expect(out).toContain('{"k":1}'); // object serialized
    expect(out).toContain("...\t"); // gap separator

    // Notified for the two clean operators only.
    const notified = onResult.mock.calls.map(c => (c as unknown as [string])[0]);
    expect(notified.sort()).toEqual([source, target]);
  });

  test("renders backend row indices, inserting an ellipsis row where they skip", async () => {
    const state = makeState(makeOperator("op1"));
    setFetchResolving(
      legacyJsonResponse({
        success: true,
        state: "Completed",
        operators: {
          op1: {
            state: "Completed",
            inputTuples: 0,
            outputTuples: 4,
            resultMode: "table",
            totalRowCount: 4,
            result: [
              { __row_index__: 0, a: 1, b: "x" },
              { __row_index__: 1, a: null, b: "NULL" },
              { __row_index__: 10, a: true, b: "has\ttab\nand newline" },
              { __row_index__: 11, a: { k: 1 } }, // a column missing from the row renders as an empty cell
            ],
          },
        },
      })
    );

    const out = await executeOperatorAndFormat(state, makeConfig(), "op1");

    expect(out.split("\n")).toEqual([
      "Executed operator op1",
      "Output table shape: (4, 2)", // __row_index__ is internal and not counted as a column
      "\ta\tb",
      "0\t1\tx",
      "1\tNaN\tNaN",
      "...\t...\t...",
      "10\ttrue\thas\\ttab\\nand newline",
      '11\t{"k":1}\t',
    ]);
  });

  test("renders only the output shape, taking totalRowCount over outputTuples; input-port shapes are not rendered", async () => {
    const dst = makeOperator("dst", { inputPorts: [{ portID: "in-0" }, { portID: "in-1" }] });
    const state = makeState(makeOperator("a"), makeOperator("b"), dst);
    state.addLink(makeLink("a", "out-0", "dst", "in-0"));
    state.addLink(makeLink("b", "out-0", "dst", "in-1"));
    setFetchResolving(
      legacyJsonResponse({
        success: true,
        state: "Completed",
        operators: {
          dst: {
            state: "Completed",
            inputTuples: 0,
            outputTuples: 99,
            resultMode: "table",
            totalRowCount: 4,
            // Legacy-only field: the adapter drops it, so it must not leak into the tool text.
            inputPortShapes: [
              { portIndex: 1, rows: 20, columns: 2 },
              { portIndex: 0, rows: 5, columns: 3 },
            ],
            result: [{ x: 1 }],
          },
        },
      })
    );

    const out = await executeOperatorAndFormat(state, makeConfig(), "dst");

    expect(out).toBe("Executed operator dst\nOutput table shape: (4, 1)\n\tx\n0\t1");
    expect(out).not.toContain("Input operator");
  });

  test("falls back to outputTuples for the row count and derives warnings from WARNING-titled console messages", async () => {
    const state = makeState(makeOperator("op1"));
    setFetchResolving(
      legacyJsonResponse({
        success: true,
        state: "Completed",
        operators: {
          op1: {
            state: "Completed",
            inputTuples: 0,
            outputTuples: 3,
            resultMode: "table",
            // The legacy `warnings` field is no longer a source of warnings.
            warnings: ["legacy warning"],
            consoleLogs: [
              { msgType: "PRINT", title: "WARNING: result truncated", message: "" },
              { msgType: "PRINT", title: "just info", message: "" },
            ],
            result: [{ x: 1 }],
          },
        },
      })
    );

    const out = await executeOperatorAndFormat(state, makeConfig(), "op1");

    expect(out.split("\n").slice(0, 3)).toEqual([
      "Executed operator op1",
      "Output table shape: (3, 1)",
      "WARNING: result truncated",
    ]);
    expect(out).not.toContain("legacy warning");
    expect(out).not.toContain("just info");
  });

  test("returns a placeholder when the operator produced no result summary", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: { [target]: { state: OperatorState.COMPLETED, errorMessages: [] } },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toBe("(no result data)");
  });

  test("emits only the summary and shape line when the result has zero sample tuples", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: { resultMode: { type: "PaginationMode" }, sampleTuples: [], totalTuplesCount: 0 },
        },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toBe(`Executed operator ${target}\nOutput table shape: (0, 0)`);
  });

  test("truncates output that exceeds the character budget, keeping the header plus head and tail rows", async () => {
    const { state, target } = makeLinearState();
    const sampleTuples: [number, Tuple][] = Array.from({ length: 12 }, (_, i) => [
      i,
      recordToTuple({ col: `value-${i}` }),
    ]);
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: { resultMode: { type: "PaginationMode" }, sampleTuples, totalTuplesCount: 12 },
        },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig({ maxOperatorResultCharLimit: 40 }), target);

    // A 40-char budget minus the header leaves room for one head row and one tail row.
    expect(out.split("\n")).toEqual([
      `Executed operator ${target}`,
      "Output table shape: (12, 1)",
      "\tcol",
      "0\tvalue-0",
      "11\tvalue-11",
    ]);
  });

  test("redacts visualization payloads from tool text without mutating the stored result", async () => {
    const { state, target } = makeLinearState();
    const html = `<div>${"x".repeat(200)}</div>`;
    const json = JSON.stringify({ points: "y".repeat(200) });
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: {
            resultMode: { type: "SetSnapshotMode" },
            sampleTuples: [[0, recordToTuple({ "html-content": html, "json-content": json, label: "chart" })]],
            totalTuplesCount: 1,
          },
        },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = mock((_operatorId: string, _info: OperatorExecutionSummary) => {});
    const out = await executeOperatorAndFormat(state, makeConfig({ maxOperatorResultCharLimit: 80 }), target, {
      onResult,
    });

    expect(out).toContain("<skipped: visualization content>");
    expect(out).not.toContain(html);
    expect(out).not.toContain(json);

    const notified = onResult.mock.calls.find(([operatorId]) => operatorId === target)?.[1];
    expect(notified?.resultSummary?.sampleTuples[0][1].fields).toContain(html);
    expect(notified?.resultSummary?.sampleTuples[0][1].fields).toContain(json);
  });
});

describe("executeOperatorAndFormat - execution failures", () => {
  test("formats per-operator errors and notifies with a synthetic failure summary (FAILED)", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.FAILED,
      operators: {
        [target]: { state: OperatorState.FAILED, errorMessages: [makeFatal("kaboom")] },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = mock(() => {});
    const out = await executeOperatorAndFormat(state, makeConfig(), target, { onResult });

    expect(out).toContain("[ERROR]");
    expect(out).toContain("Execution error:");
    expect(out).toContain(`${target}: kaboom`);

    expect(onResult).toHaveBeenCalledTimes(1);
    const [, info] = onResult.mock.calls[0] as unknown as [string, OperatorExecutionSummary];
    expect(info.state).toBe(OperatorState.FAILED);
    expect(info.errorMessages[0].type.name).toBe(WorkflowFatalErrorType.EXECUTION_FAILURE);
    expect(info.errorMessages[0].message).toContain("kaboom");
  });

  test("reports why the unit killed the run, when it says", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.KILLED,
      operators: {},
      errors: [makeFatal("Timeout after 5 seconds")],
    };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);

    expect(out).toBe("[ERROR] Execution failed due to the following error:\nError:\n  Timeout after 5 seconds");
  });

  test("says that a run killed for no stated reason was stopped or replaced, not that it timed out", async () => {
    const { state, target } = makeLinearState();
    // What a unit answers for a run that another run of the workflow took the place of.
    const summary: WorkflowExecutionSummary = { state: WorkflowExecutionState.KILLED, operators: {}, errors: [] };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);

    expect(out).toBe(
      "[ERROR] Execution failed due to the following error:\nError:\n" +
        "  The run was stopped, or replaced by another run of the workflow."
    );
  });

  test("surfaces general errors when the HTTP request itself fails (ERROR state)", async () => {
    const { state, target } = makeLinearState();
    setFetchResolving(new Response("backend detail", { status: 500, statusText: "Server Error" }));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toContain("[ERROR]");
    expect(out).toContain("Waiting for execution 345 failed: 500 Server Error - backend detail");
  });

  test("surfaces a malformed legacy response (non-array result) as a general error", async () => {
    const state = makeState(makeOperator("op1"));
    setFetchResolving(
      legacyJsonResponse({
        success: true,
        state: "Completed",
        operators: {
          op1: { state: "Completed", inputTuples: 0, outputTuples: 0, resultMode: "table", result: { rows: [] } },
        },
      })
    );

    const out = await executeOperatorAndFormat(state, makeConfig(), "op1");
    expect(out).toContain("[ERROR]");
    expect(out).toContain("Invalid legacy sync-execution response");
  });

  test("surfaces the message when fetch rejects with a non-abort error", async () => {
    const { state, target } = makeLinearState();
    setFetchRejecting(new Error("network down"));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toContain("[ERROR]");
    expect(out).toContain("network down");
  });

  test("returns a 'no result' error when the operator is missing from a completed run", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {},
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const out = await executeOperatorAndFormat(state, makeConfig(), target);
    expect(out).toContain("[ERROR]");
    expect(out).toContain(`No result found for operator: ${target}`);
  });

  test("joins operator error messages when a completed run still reports operator errors", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: { state: OperatorState.FAILED, errorMessages: [makeFatal("e1"), makeFatal("e2")] },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = mock(() => {});
    const out = await executeOperatorAndFormat(state, makeConfig(), target, { onResult });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("Execution error:");
    expect(out).toContain(`${target}: e1; e2`);

    // The operator's own summary (not a synthetic one) is what gets notified.
    expect(onResult).toHaveBeenCalledTimes(1);
    const [notifiedId, info] = onResult.mock.calls[0] as unknown as [string, OperatorExecutionSummary];
    expect(notifiedId).toBe(target);
    expect(info.errorMessages.map(e => e.message)).toEqual(["e1; e2"]);
  });
});

describe("executeOperatorAndFormat - request construction", () => {
  test("sends the upstream sub-DAG with port ordinals resolved from each operator's port list", async () => {
    const src = makeOperator("src", {
      operatorProperties: { limit: 3 },
      outputPorts: [{ portID: "output-0" }, { portID: "output-1" }],
    });
    const dst = makeOperator("dst", { inputPorts: [{ portID: "input-0" }, { portID: "input-1" }] });
    const state = makeState(src, dst);
    state.addLink(makeLink("src", "output-1", "dst", "input-0"));
    // An unknown source port falls back to ordinal 0 rather than -1.
    state.addLink(makeLink("src", "output-9", "dst", "input-1"));
    setFetchResolving(legacyJsonResponse({ success: true, state: "Completed", operators: {} }));

    await executeOperatorAndFormat(state, makeConfig({ workflowId: 7, computingUnitId: 3 }), "dst");

    // The plan goes to the Dashboard, which compiles it: the create's body carries it.
    const body = requestBody();
    // The plan is already cut to the target: the request names none for the Dashboard to cut at.
    expect(body).not.toHaveProperty("targetOperatorId");
    expect(body.logicalPlan.opsToViewResult).toEqual(["dst"]);
    expect(body.logicalPlan.links).toEqual([
      {
        fromOpId: "src",
        fromPortId: { id: 1, internal: false },
        toOpId: "dst",
        toPortId: { id: 0, internal: false },
      },
      {
        fromOpId: "src",
        fromPortId: { id: 0, internal: false },
        toOpId: "dst",
        toPortId: { id: 1, internal: false },
      },
    ]);
    // Operator properties are flattened into the wire operator alongside its ports.
    expect(body.logicalPlan.operators).toContainEqual(
      expect.objectContaining({ operatorID: "src", operatorType: "TestOp", limit: 3 })
    );
  });

  test("the create carries the picked warehouse, and omits it when none is picked; the wait never names one", async () => {
    // The last hop of the chain: the id has travelled request -> agent ->
    // delegate config -> here, and the Dashboard refuses a create without it while
    // the feature is enabled (#7751).
    const state = makeState(makeOperator("dst"));
    setFetchResolving(legacyJsonResponse({ success: true, state: "Completed", operators: {} }));

    await executeOperatorAndFormat(state, makeConfig({ workflowId: 7, computingUnitId: 3, warehouseId: 42 }), "dst");
    expect(requestBody(0).warehouseId).toBe(42);
    // The unit has the warehouse from the plan the Dashboard handed it.
    expect("warehouseId" in requestBody(1)).toBe(false);

    fetchSpy.mockClear();
    setFetchResolving(legacyJsonResponse({ success: true, state: "Completed", operators: {} }));

    await executeOperatorAndFormat(state, makeConfig({ workflowId: 7, computingUnitId: 3 }), "dst");
    expect("warehouseId" in requestBody(0)).toBe(false);
  });

  test("sends the whole workflow, not an upstream slice, when the operator id is empty", async () => {
    // The plan builder only takes the sub-DAG path for a *truthy* target id, so an empty
    // operator id falls through to the "every operator" branch. `sink` and `orphan` are the
    // tell: neither is upstream of `mid`, so a sub-DAG walk would have dropped them.
    const src = makeOperator("src", {
      operatorProperties: { limit: 3 },
      outputPorts: [{ portID: "output-0" }, { portID: "output-1" }],
    });
    const mid = makeOperator("mid", { inputPorts: [{ portID: "input-0" }], outputPorts: [{ portID: "output-0" }] });
    const sink = makeOperator("sink", { inputPorts: [{ portID: "input-0" }, { portID: "input-1" }] });
    const orphan = makeOperator("orphan");
    const off = makeOperator("off", { isDisabled: true });
    const state = makeState(src, mid, sink, orphan, off);
    state.addLink(makeLink("src", "output-1", "mid", "input-0"));
    state.addLink(makeLink("mid", "output-0", "sink", "input-1"));
    setFetchResolving(legacyJsonResponse({ success: true, state: "Completed", operators: {} }));

    await executeOperatorAndFormat(state, makeConfig(), "");

    const body = requestBody();
    expect(body.logicalPlan.operators.map((op: { operatorID: string }) => op.operatorID).sort()).toEqual([
      // getAllEnabledOperators() does not filter on isDisabled, so `off` is sent too.
      "mid",
      "off",
      "orphan",
      "sink",
      "src",
    ]);
    expect(body.logicalPlan.operators).toContainEqual(
      expect.objectContaining({ operatorID: "src", operatorType: "TestOp", limit: 3, outputPorts: src.outputPorts })
    );
    expect(body.logicalPlan.links).toEqual([
      { fromOpId: "src", fromPortId: { id: 1, internal: false }, toOpId: "mid", toPortId: { id: 0, internal: false } },
      { fromOpId: "mid", fromPortId: { id: 0, internal: false }, toOpId: "sink", toPortId: { id: 1, internal: false } },
    ]);
    // The empty id matches no operator, so nothing is requested back.
    expect(body.logicalPlan.opsToViewResult).toEqual([]);

    // Contrast: a real id takes the sub-DAG path and keeps only what feeds it.
    fetchSpy.mockClear();
    setFetchResolving(legacyJsonResponse({ success: true, state: "Completed", operators: {} }));
    await executeOperatorAndFormat(state, makeConfig(), "mid");
    expect(
      requestBody()
        .logicalPlan.operators.map((op: { operatorID: string }) => op.operatorID)
        .sort()
    ).toEqual(["mid", "src"]);
  });
});

describe("executeOperatorAndFormat - create, then wait", () => {
  const completed = () => legacyJsonResponse({ success: true, state: "Completed", operators: {} });

  test("creates the execution at the Dashboard, then waits for it at the unit, by its id", async () => {
    const state = makeState(makeOperator("dst"));
    // Not the default answer: the wait has to name the execution this create answered.
    routeFetch(createdResponse({ eid: 12 }), completed());
    const controller = new AbortController();

    await executeOperatorAndFormat(
      state,
      makeConfig({
        workflowId: 7,
        computingUnitId: 3,
        executionTimeoutMs: 4200,
        maxOperatorResultCharLimit: 111,
        maxOperatorResultCellCharLimit: 22,
      }),
      "dst",
      { abortSignal: controller.signal }
    );

    expect(requestUrls()).toEqual([CREATE_URL, `${UNIT}/api/execution/12/wait`]);
    // Both are ended by the same stop.
    for (const [, init] of fetchSpy.mock.calls) {
      const request = init as RequestInit;
      expect(request.method).toBe("POST");
      expect(request.signal).toBe(controller.signal);
    }
    // The Dashboard is asked with the user's token, which it verifies. A unit verifies no token:
    // it is handed none, and told the id of the user the token names.
    expect(requestHeaders(0)).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${USER_TOKEN}` });
    expect(requestHeaders(1)).toEqual({ "Content-Type": "application/json", "x-user-id": String(USER_ID) });
    // Exactly these fields: no settings, which the Dashboard defaults, and no warehouse, as none is picked.
    expect(requestBody(0)).toEqual({
      wid: 7,
      executionName: "agent-execution",
      engineVersion: "agent",
      logicalPlan: {
        operators: [{ operatorID: "dst", operatorType: "TestOp", inputPorts: [], outputPorts: [{ portID: "out-0" }] }],
        links: [],
        opsToViewResult: ["dst"],
        opsToReuseResult: [],
      },
      computingUnitId: 3,
      emailNotificationEnabled: false,
    });
    // The unit is sent no plan and no workflow: the Dashboard handed it the plan as it started the
    // execution. 4200 rather than a round 4500: with 4500 the timeout holds for ceil, round *and*
    // floor-plus-one, so it would not notice the rounding being changed. 4200 separates them.
    expect(requestBody(1)).toEqual({
      targetOperatorIds: ["dst"],
      timeoutSeconds: 5,
      maxOperatorResultCharLimit: 111,
      maxOperatorResultCellCharLimit: 22,
    });
  });

  test("names no computing unit as unit 0, which the Dashboard refuses before any unit is asked", async () => {
    const state = makeState(makeOperator("dst"));
    const message = "The request names no computing unit to run the workflow on.";
    routeFetch(refusedResponse(400, "Bad Request", message));

    const out = await executeOperatorAndFormat(state, makeConfig(), "dst");

    expect(requestBody(0).computingUnitId).toBe(0);
    expect(requestUrls()).toEqual([CREATE_URL]);
    expect(out).toBe(
      "[ERROR] Execution failed due to the following error:\nError:\n" +
        `  Execution request failed: 400 Bad Request - ${message}`
    );
  });

  test("reports each operator's compilation error, naming the operator, and waits for nothing", async () => {
    const { state, source, target } = makeLinearState();
    // The answer keys the errors by operator, here with the target's first: the tool lists the
    // source's, the cause, before it.
    routeFetch(
      compileFailureResponse({
        [target]: "java.lang.RuntimeException: column age does not exist",
        [source]: "java.lang.RuntimeException: No file selected.",
      })
    );
    const onResult = mock((_operatorId: string, _info: OperatorExecutionSummary) => {});

    const out = await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target, { onResult });

    const expected = [
      "Execution failed due to the following error:",
      "Compilation error:",
      `  ${source}: java.lang.RuntimeException: No file selected.`,
      `  ${target}: java.lang.RuntimeException: column age does not exist`,
    ].join("\n");
    expect(out).toBe(`[ERROR] ${expected}`);
    // There is no execution to wait for.
    expect(requestUrls()).toEqual([CREATE_URL]);
    // The target is told of the failure, as it is of any run that does not complete.
    expect(onResult).toHaveBeenCalledTimes(1);
    const [notifiedId, info] = onResult.mock.calls[0];
    expect(notifiedId).toBe(target);
    expect(info.state).toBe(OperatorState.FAILED);
    expect(info.errorMessages.map(error => error.message)).toEqual([expected]);
  });

  test.each([
    [400, "Bad Request", "A warehouse must be selected for this execution."],
    [403, "Forbidden", "You may not run workflows on computing unit 3."],
    [409, "Conflict", "Computing unit 3 is terminated."],
    [500, "Internal Server Error", "Execution 345 could not be created: its plan could not be made."],
    [504, "Gateway Timeout", "Execution 345 could not be created: compiling the workflow took longer than 60 seconds."],
    // The execution is created, and its computing unit does not start it, or does not say.
    [409, "Conflict", "Execution 345 could not be started on computing unit 3. This is computing unit 5, not 3."],
    [503, "Service Unavailable", "Execution 345 could not be started: computing unit 3 could not be reached."],
    [504, "Gateway Timeout", "Computing unit 3 did not answer whether it started execution 345. It may be running."],
  ])("reports a create refused with %d, and waits for nothing", async (status, statusText, message) => {
    const { state, target } = makeLinearState();
    routeFetch(refusedResponse(status, statusText, message));

    const out = await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target);

    expect(out).toBe(
      "[ERROR] Execution failed due to the following error:\nError:\n" +
        `  Execution request failed: ${status} ${statusText} - ${message}`
    );
    expect(requestUrls()).toEqual([CREATE_URL]);
  });

  test("reports a create whose answer names no execution, and waits for nothing", async () => {
    const { state, target } = makeLinearState();
    routeFetch(createdResponse({}), completed());

    const out = await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target);

    expect(out).toStartWith("[ERROR] Execution failed due to the following error:\nError:\n");
    expect(out).toContain("Invalid create-execution response");
    expect(requestUrls()).toEqual([CREATE_URL]);
  });

  test("reports why the unit does not wait for the execution", async () => {
    const { state, target } = makeLinearState();
    routeFetch(
      createdResponse(),
      legacyJsonResponse({
        success: false,
        state: "Error",
        operators: {},
        errors: ["Execution 345 is not running here."],
      })
    );

    const out = await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target);

    expect(out).toBe(
      "[ERROR] Execution failed due to the following error:\nError:\n  Execution 345 is not running here."
    );
    expect(requestUrls()).toEqual([CREATE_URL, WAIT_URL]);
  });

  test("reports a unit that cannot be reached once the execution is started", async () => {
    const { state, target } = makeLinearState();
    routeFetch(createdResponse(), new Error("connection refused"));

    const out = await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target);

    expect(out).toBe("[ERROR] Execution failed due to the following error:\nError:\n  connection refused");
    expect(requestUrls()).toEqual([CREATE_URL, WAIT_URL]);
  });

  test("creates at the Dashboard, and waits at the unit's own endpoint where each unit has one", async () => {
    // In K8s each unit is a pod of its own, reached through EXECUTION_ENDPOINT_TEMPLATE. Only the
    // wait goes there: no unit creates executions.
    const saved = env.EXECUTION_ENDPOINT_TEMPLATE;
    env.EXECUTION_ENDPOINT_TEMPLATE = "http://computing-unit-{cuid}.pool.svc:8085";
    try {
      const state = makeState(makeOperator("dst"));
      routeFetch(createdResponse(), completed());

      await executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), "dst");

      expect(requestUrls()).toEqual([CREATE_URL, "http://computing-unit-3.pool.svc:8085/api/execution/345/wait"]);
    } finally {
      env.EXECUTION_ENDPOINT_TEMPLATE = saved;
    }
  });
});

describe("executeOperatorAndFormat - abort and callback failures", () => {
  test("re-throws AbortError raised by the HTTP layer", async () => {
    const { state, target } = makeLinearState();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    setFetchRejecting(abortErr);

    await expect(
      executeOperatorAndFormat(state, makeConfig(), target, { abortSignal: new AbortController().signal })
    ).rejects.toThrow("aborted");
  });

  test("re-throws AbortError raised while the unit is waited for", async () => {
    const { state, target } = makeLinearState();
    const abortErr = new Error("aborted during the wait");
    abortErr.name = "AbortError";
    routeFetch(createdResponse(), abortErr);

    await expect(
      executeOperatorAndFormat(state, makeConfig(), target, { abortSignal: new AbortController().signal })
    ).rejects.toThrow("aborted during the wait");
    expect(requestUrls()).toEqual([CREATE_URL, WAIT_URL]);
  });

  test("does not wait for an execution once the tool call has been stopped", async () => {
    const { state, target } = makeLinearState();
    const controller = new AbortController();
    fetchSpy.mockImplementation(async () => {
      // The stop arrives as the Dashboard answers the create: too late to end that request, or the
      // start of the execution it made.
      controller.abort();
      return createdResponse();
    });

    await expect(
      executeOperatorAndFormat(state, makeConfig({ computingUnitId: 3 }), target, { abortSignal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestUrls()).toEqual([CREATE_URL]);
  });

  test("wraps a throwing onResult callback into an error result", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: {
            resultMode: { type: "PaginationMode" },
            sampleTuples: [[0, recordToTuple({ col: "v" })]],
            totalTuplesCount: 1,
          },
        },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = () => {
      throw new Error("cb boom");
    };
    const out = await executeOperatorAndFormat(state, makeConfig(), target, { onResult });
    expect(out).toContain("[ERROR] Execution failed: cb boom");
  });
});

describe("createExecuteOperatorTool", () => {
  test("resolves the config per invocation and forwards the operator id and onResult hook", async () => {
    const { state, target } = makeLinearState();
    const summary: WorkflowExecutionSummary = {
      state: WorkflowExecutionState.COMPLETED,
      operators: {
        [target]: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          resultSummary: {
            resultMode: { type: "PaginationMode" },
            sampleTuples: [[0, recordToTuple({ col: "v" })]],
            totalTuplesCount: 1,
          },
        },
      },
      errors: [],
    };
    setFetchResolving(jsonResponse(summary));

    const onResult = mock(() => {});
    let workflowId = 42;
    const getConfig = mock(() => makeConfig({ workflowId, computingUnitId: 2 }));

    const executeTool = createExecuteOperatorTool(state, getConfig, onResult);
    expect(typeof executeTool.execute).toBe("function");

    const out = await runTool(executeTool, target);
    // Invoked twice, with the workflow id changing in between. One invocation cannot tell
    // per-invocation resolution from a config captured once when the tool was built: the call
    // count is 1 either way. The second create is what proves the later config is the one used.
    workflowId = 43;
    setFetchResolving(jsonResponse(summary)); // a Response body is single-use
    await runTool(executeTool, target);

    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(out).toContain(`Executed operator ${target}`);
    // Each invocation creates its own execution, then waits for it.
    expect(requestUrls()).toEqual([CREATE_URL, WAIT_URL, CREATE_URL, WAIT_URL]);
    expect(requestBody(0)).toMatchObject({ wid: 42, computingUnitId: 2 });
    expect(requestBody(2)).toMatchObject({ wid: 43, computingUnitId: 2 });
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(target, expect.anything());
  });
});
