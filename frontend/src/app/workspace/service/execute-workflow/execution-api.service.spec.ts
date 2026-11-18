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

import { TestBed } from "@angular/core/testing";
import { HttpErrorResponse } from "@angular/common/http";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import {
  CreateExecutionRequest,
  CreateExecutionResponse,
  ExecutionApiService,
  ExecutionStateResponse,
  failureMessage,
  operatorErrorsOf,
  OperatorUpdateResponse,
} from "./execution-api.service";
import { ExecutionMode } from "../../../common/type/workflow";
import { LogicalPlan } from "../../types/execute-workflow.interface";
import { WorkflowFatalError } from "../../types/workflow-websocket.interface";

describe("ExecutionApiService", () => {
  // Written out, not read from the service's constant: the Dashboard serves the route here.
  const EXECUTIONS_URL = "api/executions";

  let service: ExecutionApiService;
  let httpMock: HttpTestingController;

  const compileError = (operatorId: string, message: string): WorkflowFatalError => ({
    type: { name: "COMPILATION_ERROR" },
    timestamp: { seconds: 1700000000, nanos: 5 },
    message,
    details: "",
    operatorId,
    workerId: "",
  });

  const request: CreateExecutionRequest = {
    wid: 12,
    executionName: "Untitled Execution",
    engineVersion: "1.4.0-SNAPSHOT",
    logicalPlan: {
      operators: [{ operatorID: "udf-1", operatorType: "PythonUDFV2", code: "pass" }],
      links: [],
      opsToViewResult: ["udf-1"],
      opsToReuseResult: [],
    },
    workflowSettings: { dataTransferBatchSize: 400, executionMode: ExecutionMode.PIPELINED },
    emailNotificationEnabled: false,
    computingUnitId: 3,
    warehouseId: 7,
    replayFromExecution: { eid: 340, interaction: "interaction-9" },
  };

  // A scan, a filter on what it reads, and a sort of what the filter keeps, listed downstream first.
  const pipeline: LogicalPlan = {
    operators: [
      { operatorID: "sort-c", operatorType: "Sort" },
      { operatorID: "filter-a", operatorType: "Filter" },
      { operatorID: "scan-b", operatorType: "CSVFileScan" },
    ],
    links: [
      {
        fromOpId: "filter-a",
        fromPortId: { id: 0, internal: false },
        toOpId: "sort-c",
        toPortId: { id: 0, internal: false },
      },
      {
        fromOpId: "scan-b",
        fromPortId: { id: 0, internal: false },
        toOpId: "filter-a",
        toPortId: { id: 0, internal: false },
      },
    ],
    opsToViewResult: [],
    opsToReuseResult: [],
  };

  // What the Dashboard answers for a workflow that does not compile, its operators' errors keyed in an
  // order that is not the workflow's.
  const compileFailure = {
    code: 400,
    message: "The workflow does not compile: 2 operators have errors.",
    eid: 345,
    operatorErrors: {
      "filter-a": compileError("filter-a", "attribute region does not exist"),
      "scan-b": compileError("scan-b", "No file selected"),
    },
  };

  /** The error a request fails with once it is answered `status` with `body`. */
  const failureOf = (status: number, statusText: string, body: unknown): HttpErrorResponse =>
    new HttpErrorResponse({ status, statusText, error: body, url: EXECUTIONS_URL });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
    });
    service = TestBed.inject(ExecutionApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe("create", () => {
    it("posts the request to /api/executions and hands back the execution created", () => {
      let created: CreateExecutionResponse | undefined;
      service.create(request).subscribe(response => (created = response));

      const req = httpMock.expectOne(EXECUTIONS_URL);
      expect(req.request.method).toBe("POST");
      expect(req.request.body).toEqual(request);
      const answer: CreateExecutionResponse = { eid: 345, planUri: "vfs:///wh/user-1-7/wid/12/eid/345/plan" };
      req.flush(answer, { status: 201, statusText: "Created" });

      expect(created).toEqual(answer);
    });

    it("writes neither a warehouse nor a replay that the request does not name", () => {
      service.create({ ...request, warehouseId: undefined, replayFromExecution: undefined }).subscribe();

      const req = httpMock.expectOne(EXECUTIONS_URL);
      // What goes on the wire: the Dashboard reads a key left out as no warehouse and no replay.
      expect(Object.keys(JSON.parse(req.request.serializeBody() as string)).sort()).toEqual([
        "computingUnitId",
        "emailNotificationEnabled",
        "engineVersion",
        "executionName",
        "logicalPlan",
        "wid",
        "workflowSettings",
      ]);
      req.flush({ eid: 1, planUri: "vfs:///wid/12/eid/1/plan" }, { status: 201, statusText: "Created" });
    });

    it("fails with the operators' errors of a workflow that does not compile", () => {
      let failure: unknown;
      service.create({ ...request, logicalPlan: pipeline }).subscribe({
        next: () => {
          throw new Error("a compile failure must not be taken for an execution created");
        },
        error: (error: unknown) => (failure = error),
      });

      httpMock.expectOne(EXECUTIONS_URL).flush(compileFailure, { status: 400, statusText: "Bad Request" });

      expect(operatorErrorsOf(failure, pipeline)).toEqual([
        compileFailure.operatorErrors["scan-b"],
        compileFailure.operatorErrors["filter-a"],
      ]);
      // It is a refusal like any other, with a reason of its own.
      expect(failureMessage(failure)).toBe("The workflow does not compile: 2 operators have errors.");
    });

    it.each([
      [400, "Bad Request", "The request names no workflow."],
      [403, "Forbidden", "You may not run workflows on computing unit 3."],
      [409, "Conflict", "Computing unit 3 is terminated."],
      [500, "Server Error", "Execution 345 could not be created: its plan could not be written to the lake."],
      [
        504,
        "Gateway Timeout",
        "Execution 345 could not be created: compiling the workflow took longer than 60 seconds.",
      ],
    ])("fails with the Dashboard's reason for a request it answers %s", (status, statusText, message) => {
      let failure: unknown;
      service.create(request).subscribe({ error: (error: unknown) => (failure = error) });

      httpMock.expectOne(EXECUTIONS_URL).flush({ code: status, message }, { status, statusText });

      expect(operatorErrorsOf(failure, request.logicalPlan)).toBeUndefined();
      expect(failureMessage(failure)).toBe(message);
    });
  });

  describe("postUpdate", () => {
    const operator = { operatorID: "PythonUDFV2-operator-1", operatorType: "PythonUDFV2", code: "x = 1" };

    it("posts the operator, as {operator}, to the execution's updates and hands back the change stored", () => {
      let stored: OperatorUpdateResponse | undefined;
      service.postUpdate(345, operator).subscribe(response => (stored = response));

      const req = httpMock.expectOne(`${EXECUTIONS_URL}/345/updates`);
      expect(req.request.method).toBe("POST");
      expect(req.request.body).toEqual({ operator });
      req.flush(
        { updateId: "update-4f6c", operatorId: "PythonUDFV2-operator-1" },
        { status: 201, statusText: "Created" }
      );

      expect(stored).toEqual({ updateId: "update-4f6c", operatorId: "PythonUDFV2-operator-1" });
    });

    it("fails with the Dashboard's reason for a change it refuses", () => {
      let failure: unknown;
      service.postUpdate(345, operator).subscribe({ error: (error: unknown) => (failure = error) });

      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/updates`)
        .flush({ code: 409, message: "Execution 345 has ended." }, { status: 409, statusText: "Conflict" });

      expect(failureMessage(failure)).toBe("Execution 345 has ended.");
    });
  });

  describe("getState", () => {
    it("gets the execution's state from /api/executions/{eid}/state and hands back the answer", () => {
      let state: ExecutionStateResponse | undefined;
      service.getState(345).subscribe(response => (state = response));

      const req = httpMock.expectOne(`${EXECUTIONS_URL}/345/state`);
      expect(req.request.method).toBe("GET");
      expect(req.request.body).toBeNull();
      const answer = { eid: 345, status: 4, open: false, reason: "unit lost", timeMs: 1794873600000 };
      req.flush(answer);

      expect(state).toEqual(answer);
    });

    it("asks again each time it is subscribed to, as the state of an open execution changes", () => {
      const states: ExecutionStateResponse[] = [];
      const state$ = service.getState(345);

      state$.subscribe(response => states.push(response));
      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/state`)
        .flush({ eid: 345, status: 1, open: true, reason: null, timeMs: 1794873000000 });
      state$.subscribe(response => states.push(response));
      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/state`)
        .flush({ eid: 345, status: 3, open: false, reason: null, timeMs: 1794873600000 });

      expect(states.map(state => state.status)).toEqual([1, 3]);
    });

    it("fails with the Dashboard's reason for an execution the caller may not read", () => {
      let failure: unknown;
      service.getState(345).subscribe({ error: (error: unknown) => (failure = error) });

      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/state`)
        .flush({ code: 403, message: "You may not read execution 345." }, { status: 403, statusText: "Forbidden" });

      expect(failureMessage(failure)).toBe("You may not read execution 345.");
    });
  });

  describe("operatorErrorsOf", () => {
    const answered = (operatorErrors: unknown): HttpErrorResponse =>
      failureOf(400, "Bad Request", { code: 400, message: "The workflow does not compile.", eid: 1, operatorErrors });

    it("lists each operator's error after those of the operators upstream of it, whatever order they are keyed in", () => {
      const errors = {
        "sort-c": compileError("sort-c", "c"),
        "scan-b": compileError("scan-b", "b"),
        "filter-a": compileError("filter-a", "a"),
      };

      expect(operatorErrorsOf(answered(errors), pipeline)?.map(error => error.operatorId)).toEqual([
        "scan-b",
        "filter-a",
        "sort-c",
      ]);
      // The same errors keyed in another order.
      const reversed = Object.fromEntries(Object.entries(errors).reverse());
      expect(operatorErrorsOf(answered(reversed), pipeline)?.map(error => error.operatorId)).toEqual([
        "scan-b",
        "filter-a",
        "sort-c",
      ]);
    });

    it("lists operators that do not depend on one another in the plan's order", () => {
      const twoScans: LogicalPlan = {
        operators: [
          { operatorID: "scan-z", operatorType: "CSVFileScan" },
          { operatorID: "scan-a", operatorType: "CSVFileScan" },
        ],
        links: [],
        opsToViewResult: [],
        opsToReuseResult: [],
      };
      const errors = { "scan-a": compileError("scan-a", "a"), "scan-z": compileError("scan-z", "z") };

      expect(operatorErrorsOf(answered(errors), twoScans)?.map(error => error.operatorId)).toEqual([
        "scan-z",
        "scan-a",
      ]);
    });

    it("drops no error: one of an operator the plan does not have comes last, and a cycle ends", () => {
      const cyclic: LogicalPlan = {
        ...pipeline,
        links: [
          ...pipeline.links,
          {
            fromOpId: "sort-c",
            fromPortId: { id: 0, internal: false },
            toOpId: "scan-b",
            toPortId: { id: 0, internal: false },
          },
        ],
      };
      const errors = { ghost: compileError("ghost", "g"), "filter-a": compileError("filter-a", "a") };

      expect(operatorErrorsOf(answered(errors), cyclic)?.map(error => error.operatorId)).toEqual(["filter-a", "ghost"]);
    });

    it("lists no error for an operator that has none, whatever it is called", () => {
      // An id that every object answers to, as a member it inherits.
      const plan: LogicalPlan = {
        ...pipeline,
        operators: [{ operatorID: "toString", operatorType: "Sort" }, ...pipeline.operators],
      };
      const errors = { "scan-b": compileError("scan-b", "b") };

      expect(operatorErrorsOf(answered(errors), plan)).toEqual([errors["scan-b"]]);
    });

    it.each([
      ["a refusal with no operators' errors", { code: 400, message: "The request names no workflow." }],
      ["no body", null],
      ["a text body", "<html>Bad Gateway</html>"],
      ["a number", 400],
      ["operators' errors with no code and message", { eid: 1, operatorErrors: { a: compileError("a", "x") } }],
      ["errors keyed by nothing", { code: 400, message: "no", eid: 1, operatorErrors: null }],
      ["errors of operators as a list", { code: 400, message: "no", eid: 1, operatorErrors: [compileError("a", "x")] }],
    ])("finds none in %s", (_, body) => {
      expect(operatorErrorsOf(failureOf(400, "Bad Request", body), pipeline)).toBeUndefined();
    });

    it("finds none in an error that is no HTTP answer", () => {
      expect(operatorErrorsOf({ error: compileFailure }, pipeline)).toBeUndefined();
      expect(operatorErrorsOf(new Error("boom"), pipeline)).toBeUndefined();
      expect(operatorErrorsOf(undefined, pipeline)).toBeUndefined();
    });
  });

  describe("failureMessage", () => {
    it("is the reason the Dashboard gives, also for a failure it only logs", () => {
      const logged = "There was an error processing your request. It has been logged (ID 5f2c1a9be0d34c77).";

      expect(failureMessage(failureOf(500, "Server Error", { code: 500, message: logged }))).toBe(logged);
    });

    it.each([
      ["a gateway's error page", 502, "Bad Gateway", "<html><h1>502 Bad Gateway</h1></html>"],
      ["a body with no reason", 500, "Server Error", { code: 500 }],
      ["a reason that is no text", 400, "Bad Request", { code: 400, message: { text: "no" } }],
      ["an empty body", 504, "Gateway Timeout", null],
    ])("says how the service answered, for %s", (_, status, statusText, body) => {
      expect(failureMessage(failureOf(status, statusText, body))).toBe(
        `The Dashboard service answered ${status} ${statusText}.`
      );
    });

    it("says that the service could not be reached, for a request that got no answer", () => {
      expect(failureMessage(failureOf(0, "Unknown Error", new ProgressEvent("error")))).toBe(
        "The Dashboard service could not be reached."
      );
    });

    it("says that the workflow is too large, for a request a proxy refuses for its size", () => {
      expect(failureMessage(failureOf(413, "Request Entity Too Large", "<html>413</html>"))).toBe(
        "The workflow is larger than this deployment accepts in one request."
      );
    });

    it("is the error itself when it is no HTTP answer", () => {
      expect(failureMessage(new Error("boom"))).toBe("Error: boom");
      expect(failureMessage("offline")).toBe("offline");
    });
  });
});
