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
  compileFailureOf,
  CreateExecutionFailure,
  CreateExecutionRequest,
  CreateExecutionResponse,
  ExecutionApiService,
  failureMessage,
  OperatorUpdateResponse,
} from "./execution-api.service";
import { ExecutionMode } from "../../../common/type/workflow";
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

  const compileFailure: CreateExecutionFailure = {
    eid: 345,
    operatorErrors: {
      "scan-operator-b": compileError("scan-operator-b", "No file selected"),
      "filter-operator-a": compileError("filter-operator-a", "attribute region does not exist"),
    },
    errors: [],
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
      const answer: CreateExecutionResponse = {
        eid: 345,
        wid: 12,
        computingUnitId: 3,
        planUri: "vfs:///wh/user-1-7/wid/12/eid/345/plan",
      };
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
      req.flush({ eid: 1, wid: 12, computingUnitId: 3, planUri: "vfs:///wid/12/eid/1/plan" });
    });

    it("fails with the compile failure of a workflow that does not compile, its errors in the order sent", () => {
      let failure: unknown;
      service.create(request).subscribe({
        next: () => {
          throw new Error("a compile failure must not be taken for an execution created");
        },
        error: (error: unknown) => (failure = error),
      });

      httpMock.expectOne(EXECUTIONS_URL).flush(compileFailure, { status: 400, statusText: "Bad Request" });

      expect(compileFailureOf(failure)).toEqual(compileFailure);
      expect(Object.keys(compileFailureOf(failure)!.operatorErrors)).toEqual(["scan-operator-b", "filter-operator-a"]);
    });

    it.each([
      [400, "Bad Request", "The request names no workflow: wid is 0."],
      [403, "Forbidden", "You may not run workflows on computing unit 3."],
      [409, "Conflict", "computing unit 3 is terminated"],
      [500, "Server Error", "Execution 345 could not be created: its plan could not be written to the lake."],
    ])("fails with the Dashboard's reason for a request it answers %s", (status, statusText, message) => {
      let failure: unknown;
      service.create(request).subscribe({ error: (error: unknown) => (failure = error) });

      httpMock.expectOne(EXECUTIONS_URL).flush({ code: status, message }, { status, statusText });

      expect(compileFailureOf(failure)).toBeUndefined();
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
      req.flush({ updateId: "update-4f6c", operatorId: "PythonUDFV2-operator-1" });

      expect(stored).toEqual({ updateId: "update-4f6c", operatorId: "PythonUDFV2-operator-1" });
    });

    it("fails with the Dashboard's reason for a change it refuses", () => {
      let failure: unknown;
      service.postUpdate(345, operator).subscribe({ error: (error: unknown) => (failure = error) });

      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/updates`)
        .flush({ code: 409, message: "execution 345 has ended" }, { status: 409, statusText: "Conflict" });

      expect(failureMessage(failure)).toBe("execution 345 has ended");
    });
  });

  describe("compileFailureOf", () => {
    it("knows a compile failure that has no error outside its operators", () => {
      const failure: CreateExecutionFailure = { eid: 1, operatorErrors: { a: compileError("a", "x") }, errors: [] };

      expect(compileFailureOf(failureOf(400, "Bad Request", failure))).toEqual(failure);
    });

    it.each([
      ["a refusal", { code: 400, message: "The request names no workflow: wid is 0." }],
      ["no body", null],
      ["a text body", "<html>Bad Gateway</html>"],
      ["a number", 400],
      ["errors keyed by nothing", { eid: 1, operatorErrors: null, errors: [] }],
      ["errors of operators as a list", { eid: 1, operatorErrors: [compileError("a", "x")], errors: [] }],
      ["no list of general errors", { eid: 1, operatorErrors: {} }],
      ["general errors that are no list", { eid: 1, operatorErrors: {}, errors: "boom" }],
    ])("does not take %s for one", (_, body) => {
      expect(compileFailureOf(failureOf(400, "Bad Request", body))).toBeUndefined();
    });

    it("does not take an error that is no HTTP answer for one", () => {
      expect(compileFailureOf({ error: compileFailure })).toBeUndefined();
      expect(compileFailureOf(new Error("boom"))).toBeUndefined();
      expect(compileFailureOf(undefined)).toBeUndefined();
    });
  });

  describe("failureMessage", () => {
    it("is the reason the Dashboard gives, also for a failure it only logs", () => {
      const logged = "There was an error processing your request. It has been logged (ID 5f2c1a9be0d34c77).";

      expect(failureMessage(failureOf(500, "Server Error", { code: 500, message: logged }))).toBe(logged);
    });

    it.each([
      ["a gateway's error page", 502, "Bad Gateway", "<html><h1>502 Bad Gateway</h1></html>"],
      ["a request that got no answer", 0, "Unknown Error", new ProgressEvent("error")],
      ["a body with no reason", 500, "Server Error", { code: 500 }],
      ["a reason that is no text", 400, "Bad Request", { code: 400, message: { text: "no" } }],
      ["an empty body", 504, "Gateway Timeout", null],
    ])("is the failed request as the browser reports it, for %s", (_, status, statusText, body) => {
      expect(failureMessage(failureOf(status, statusText, body))).toBe(
        `Http failure response for ${EXECUTIONS_URL}: ${status} ${statusText}`
      );
    });

    it("is the error itself when it is no HTTP answer", () => {
      expect(failureMessage(new Error("boom"))).toBe("Error: boom");
      expect(failureMessage("offline")).toBe("offline");
    });
  });
});
