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

import { describe, expect, test } from "bun:test";
import { adaptCreateExecutionFailure, adaptLegacySyncExecutionResult, parseCreatedExecution } from "./execution-api";
import { ConsoleMessageType, OperatorState, WorkflowExecutionState, WorkflowFatalErrorType } from "../types/execution";

// A WorkflowFatalError as the Dashboard service writes one for a workflow that does not compile.
function compilationError(operatorId: string, message: string) {
  return {
    type: { name: "COMPILATION_ERROR" },
    timestamp: { seconds: 1794873600, nanos: 5 },
    message,
    details: `${message}\n\tat org.apache.texera.common.compiler.WorkflowCompiler.compile`,
    operatorId,
    workerId: "",
  };
}

describe("parseCreatedExecution", () => {
  test("reads the execution's id and plan table from the Dashboard's answer", () => {
    const created = parseCreatedExecution({
      eid: 345,
      wid: 12,
      computingUnitId: 3,
      planUri: "vfs:///wh/user-1-7/wid/12/eid/345/plan",
    });

    expect(created).toEqual({ eid: 345, planUri: "vfs:///wh/user-1-7/wid/12/eid/345/plan" });
  });

  test.each([
    ["no plan table", { eid: 345, wid: 12, computingUnitId: 3 }],
    ["an empty plan table", { eid: 345, planUri: "" }],
    ["no execution id", { wid: 12, planUri: "vfs:///wid/12/eid/345/plan" }],
    ["an execution id that is text", { eid: "345", planUri: "vfs:///wid/12/eid/345/plan" }],
    ["an execution id that is not a whole number", { eid: 3.5, planUri: "vfs:///wid/12/eid/3/plan" }],
    ["an execution id below 1", { eid: 0, planUri: "vfs:///wid/12/eid/0/plan" }],
    ["no object at all", null],
  ])("refuses an answer with %s", (_case, answer) => {
    expect(() => parseCreatedExecution(answer)).toThrow("Invalid create-execution response");
  });
});

describe("adaptCreateExecutionFailure", () => {
  test("turns a workflow that does not compile into each operator's error, in the order listed, then the others", () => {
    const summary = adaptCreateExecutionFailure(
      400,
      "Bad Request",
      JSON.stringify({
        eid: 345,
        // Not sorted: the Dashboard lists the operators in the order of the workflow.
        operatorErrors: {
          "scan-2": compilationError("scan-2", "java.lang.RuntimeException: No file selected."),
          "filter-1": compilationError("filter-1", "java.lang.RuntimeException: column age does not exist"),
        },
        errors: [compilationError("", "java.lang.IllegalStateException: the plan cannot be scheduled")],
      })
    );

    expect(summary.state).toBe(WorkflowExecutionState.COMPILATION_FAILED);
    expect(summary.operators).toEqual({});
    expect(summary.errors.map(error => [error.type.name, error.operatorId, error.message])).toEqual([
      [WorkflowFatalErrorType.COMPILATION_ERROR, "scan-2", "java.lang.RuntimeException: No file selected."],
      [WorkflowFatalErrorType.COMPILATION_ERROR, "filter-1", "java.lang.RuntimeException: column age does not exist"],
      [WorkflowFatalErrorType.COMPILATION_ERROR, "", "java.lang.IllegalStateException: the plan cannot be scheduled"],
    ]);
  });

  test("reads only each error's message, and does not require the errors of no operator", () => {
    const summary = adaptCreateExecutionFailure(
      400,
      "Bad Request",
      JSON.stringify({ eid: 345, operatorErrors: { "udf-1": { message: "invalid syntax" } } })
    );

    expect(summary.state).toBe(WorkflowExecutionState.COMPILATION_FAILED);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      type: { name: WorkflowFatalErrorType.COMPILATION_ERROR },
      message: "invalid syntax",
      details: "",
      operatorId: "udf-1",
      workerId: "",
    });
  });

  test.each([
    [400, "Bad Request", "The request names no computing unit: computingUnitId is 0."],
    [403, "Forbidden", "You may not run workflows on computing unit 3."],
    [409, "Conflict", "computing unit 3 is terminated"],
    [500, "Internal Server Error", "Execution 345 could not be created: its plan could not be written to the lake."],
  ])("turns a %d refusal into an error with its status and message", (status, statusText, message) => {
    const summary = adaptCreateExecutionFailure(status, statusText, JSON.stringify({ code: status, message }));

    expect(summary.state).toBe(WorkflowExecutionState.ERROR);
    expect(summary.operators).toEqual({});
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      type: { name: WorkflowFatalErrorType.EXECUTION_FAILURE },
      message: `Execution could not be created: ${status} ${statusText} - ${message}`,
      operatorId: "",
    });
  });

  test("takes an answer that is not JSON as it is", () => {
    const body = "Credentials are required to access this resource.\n";

    const summary = adaptCreateExecutionFailure(401, "Unauthorized", body);

    expect(summary.state).toBe(WorkflowExecutionState.ERROR);
    expect(summary.errors[0].message).toBe(
      "Execution could not be created: 401 Unauthorized - Credentials are required to access this resource."
    );
  });

  test("names only what the answer has: no body, no status text, or a blank message", () => {
    const messageOf = (status: number, statusText: string, body: string) =>
      adaptCreateExecutionFailure(status, statusText, body).errors[0].message;

    expect(messageOf(502, "Bad Gateway", "")).toBe("Execution could not be created: 502 Bad Gateway");
    expect(messageOf(503, "", "upstream connect error")).toBe(
      "Execution could not be created: 503 - upstream connect error"
    );
    expect(messageOf(500, "Internal Server Error", JSON.stringify({ code: 500, message: " " }))).toBe(
      "Execution could not be created: 500 Internal Server Error"
    );
  });

  test("reads compilation errors only from a 400", () => {
    const body = JSON.stringify({
      eid: 345,
      operatorErrors: { scan: compilationError("scan", "java.lang.RuntimeException: No file selected.") },
      errors: [],
    });

    const summary = adaptCreateExecutionFailure(500, "Internal Server Error", body);

    expect(summary.state).toBe(WorkflowExecutionState.ERROR);
    expect(summary.errors.map(error => error.message)).toEqual([
      `Execution could not be created: 500 Internal Server Error - ${body}`,
    ]);
  });

  test.each([
    ["lists no error at all", { eid: 345, operatorErrors: {}, errors: [] }],
    ["lists an operator's error that has no message", { eid: 345, operatorErrors: { scan: { operatorId: "scan" } } }],
    ["is neither a refusal nor a list of errors", { eid: 345 }],
  ])("reports a 400 that %s as the answer it is", (_case, answer) => {
    const body = JSON.stringify(answer);

    const summary = adaptCreateExecutionFailure(400, "Bad Request", body);

    expect(summary.state).toBe(WorkflowExecutionState.ERROR);
    expect(summary.errors.map(error => error.message)).toEqual([
      `Execution could not be created: 400 Bad Request - ${body}`,
    ]);
  });
});

describe("adaptLegacySyncExecutionResult", () => {
  test("normalizes sampled table rows, row gaps, counts, and console messages", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: {
        target: {
          state: "Completed",
          inputTuples: 10,
          outputTuples: 10,
          resultMode: "table",
          result: [
            { __row_index__: 2, name: "alice", score: 1, active: true },
            { __row_index__: 9, name: null, score: { nested: "value" }, active: false },
          ],
          totalRowCount: 10,
          displayedRows: 2,
          truncated: true,
          consoleLogs: [{ msgType: "PRINT", title: "WARNING: sampled", message: "sampled" }],
          warnings: ["WARNING: sampled"],
        },
      },
    });

    expect(summary).not.toHaveProperty("success");
    expect(summary).toMatchObject({
      state: WorkflowExecutionState.COMPLETED,
      errors: [],
      operators: {
        target: {
          state: OperatorState.COMPLETED,
          errorMessages: [],
          consoleMessages: [{ msgType: ConsoleMessageType.PRINT, title: "WARNING: sampled", message: "sampled" }],
          resultSummary: {
            resultMode: { type: "PaginationMode" },
            totalTuplesCount: 10,
          },
        },
      },
    });
    expect(summary.operators.target.resultSummary?.sampleTuples).toEqual([
      [
        2,
        {
          schema: {
            attributes: [
              { attributeName: "name", attributeType: "string" },
              { attributeName: "score", attributeType: "string" },
              { attributeName: "active", attributeType: "string" },
            ],
          },
          fields: ["alice", "1", "true"],
        },
      ],
      [
        9,
        {
          schema: {
            attributes: [
              { attributeName: "name", attributeType: "string" },
              { attributeName: "score", attributeType: "string" },
              { attributeName: "active", attributeType: "string" },
            ],
          },
          fields: [null, '{"nested":"value"}', "false"],
        },
      ],
    ]);
  });

  test("normalizes visualization markers without exposing backend metadata columns", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: {
        chart: {
          state: "Completed",
          inputTuples: 1,
          outputTuples: 1,
          resultMode: "visualization",
          result: [{ __is_visualization__: true, "html-content": "<p>chart</p>" }],
          totalRowCount: 1,
        },
      },
    });

    expect(summary.operators.chart.resultSummary).toEqual({
      resultMode: { type: "SetSnapshotMode" },
      sampleTuples: [
        [
          0,
          {
            schema: { attributes: [{ attributeName: "html-content", attributeType: "string" }] },
            fields: ["<p>chart</p>"],
          },
        ],
      ],
      totalTuplesCount: 1,
    });
  });

  test("turns operator and workflow error strings into execution failures", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: false,
      state: "Failed",
      operators: {
        broken: {
          state: "Failed",
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "table",
          error: "operator exploded",
        },
      },
      errors: ["workflow stopped"],
    });

    expect(summary.operators.broken.errorMessages[0]).toMatchObject({
      type: { name: WorkflowFatalErrorType.EXECUTION_FAILURE },
      message: "operator exploded",
      operatorId: "broken",
    });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      type: { name: WorkflowFatalErrorType.EXECUTION_FAILURE },
      message: "workflow stopped",
      operatorId: "",
    });
  });

  test("normalizes a completed legacy failure to the failed state", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: false,
      state: "Completed",
      operators: {
        target: {
          state: "Completed",
          inputTuples: 1,
          outputTuples: 1,
          resultMode: "table",
          error: "console error",
        },
      },
    });

    expect(summary).not.toHaveProperty("success");
    expect(summary.state).toBe(WorkflowExecutionState.FAILED);
  });

  test("lists an error the unit reports more than once only once, as a failure of the run", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: false,
      state: "Failed",
      operators: {},
      errors: [
        "EXECUTION_FAILURE: worker crashed",
        "EXECUTION_FAILURE: worker crashed",
        "EXECUTION_FAILURE: disk full",
      ],
    });

    expect(summary.state).toBe(WorkflowExecutionState.FAILED);
    expect(summary.errors.map(error => [error.type.name, error.message, error.operatorId])).toEqual([
      [WorkflowFatalErrorType.EXECUTION_FAILURE, "EXECUTION_FAILURE: worker crashed", ""],
      [WorkflowFatalErrorType.EXECUTION_FAILURE, "EXECUTION_FAILURE: disk full", ""],
    ]);
  });

  test("keeps an absent materialized result absent and defaults optional errors to empty", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: {
        sink: {
          state: "Completed",
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "table",
        },
      },
    });

    expect(summary.errors).toEqual([]);
    expect(summary.operators.sink.resultSummary).toBeUndefined();
    expect(summary.operators.sink.consoleMessages).toBeUndefined();
  });

  test("drops console messages of an unrecognized type instead of rejecting the run", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: {
        target: {
          state: "Completed",
          outputTuples: 1,
          resultMode: "table",
          result: [{ value: "x" }],
          consoleLogs: [
            { msgType: "UNRECOGNIZED", title: "from a newer engine", message: "" },
            { msgType: "PRINT", title: "WARNING: kept", message: "" },
          ],
        },
      },
    });

    expect(summary.state).toBe(WorkflowExecutionState.COMPLETED);
    expect(summary.operators.target.consoleMessages).toEqual([
      { msgType: ConsoleMessageType.PRINT, title: "WARNING: kept", message: "" },
    ]);
  });

  test("leaves console messages absent when none has a recognized type", () => {
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: {
        target: {
          state: "Completed",
          outputTuples: 0,
          resultMode: "table",
          consoleLogs: [{ msgType: "UNRECOGNIZED", title: "", message: "" }],
        },
      },
    });

    expect(summary.operators.target.consoleMessages).toBeUndefined();
  });

  test("does not require legacy fields the adapter never reads", () => {
    // inputTuples, inputPortShapes, displayedRows, truncated and warnings are not
    // part of the canonical model, so their absence must not fail the run.
    const summary = adaptLegacySyncExecutionResult({
      success: true,
      state: "Completed",
      operators: { target: { state: "Completed", outputTuples: 3, resultMode: "table", result: [] } },
    });

    expect(summary.operators.target.resultSummary?.totalTuplesCount).toBe(3);
  });

  test("rejects a malformed response instead of trusting an unchecked cast", () => {
    expect(() => adaptLegacySyncExecutionResult({ success: "yes", state: "Completed", operators: {} })).toThrow(
      "Invalid legacy sync-execution response"
    );
  });

  test("rejects an unsupported legacy result mode", () => {
    expect(() =>
      adaptLegacySyncExecutionResult({
        success: true,
        state: "Completed",
        operators: {
          target: {
            state: "Completed",
            inputTuples: 1,
            outputTuples: 1,
            resultMode: "delta",
          },
        },
      })
    ).toThrow("Invalid legacy sync-execution response");
  });

  test("rejects malformed row-index metadata", () => {
    expect(() =>
      adaptLegacySyncExecutionResult({
        success: true,
        state: "Completed",
        operators: {
          target: {
            state: "Completed",
            inputTuples: 1,
            outputTuples: 1,
            resultMode: "table",
            result: [{ __row_index__: "first", value: "x" }],
          },
        },
      })
    ).toThrow("Invalid __row_index__ for sampled row 0");
  });
});
