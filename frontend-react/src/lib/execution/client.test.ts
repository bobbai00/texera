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

import { http, HttpResponse, ws } from "msw";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { logicalPlan } from "@/lib/workflow/plan";
import { defaultSettings, type WorkflowSettings } from "@/lib/workflow/model";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { link, operator, workflowContent } from "@/testing/workflow";
import { dashboardFollowMs, ExecutionClient } from "./client";
import type { ExecutionRequest, ExecutionState } from "./protocol";

const penguins = {
  columns: [
    { attributeName: "species", attributeType: "string" },
    { attributeName: "mass", attributeType: "integer" },
  ],
  rows: [
    { species: "Adelie", mass: 3750 },
    { species: "Gentoo", mass: 5000 },
    { species: "Chinstrap", mass: 3500 },
  ],
};

const scan = operator("CSVFileScan", "scan", { fileName: "penguins.csv" });
const filter = operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] });
const limit = operator("Limit", "limit", { limit: 5 });

/** scan -> filter (mass > 3600) -> limit: the limit's two rows are kept as the result. */
const plan = logicalPlan(workflowContent([scan, filter, limit], [link("scan", "filter"), link("filter", "limit")]));

/** The engine's socket, as the test sees it beside the fake engine. MSW keeps the clients of each link it makes. */
const engine = ws.link(`ws://${window.location.host}/wsapi/workflow-websocket`);
const tooSlow = "Computing unit 1 did not answer whether it started execution 4. It may be running.";

/** The workflow and the unit the clients execute on: the admin's, as the admin is signed in. */
let wid: number;
let cuid: number;

/** A client of a workflow on a unit, connected, which closes when the test ends. */
async function connect(workflowId = wid, unitId = cuid) {
  const client = new ExecutionClient(workflowId, unitId);
  onTestFinished(() => client.close());
  client.connect();
  await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
  return client;
}

/** The test speaks for the engine, beside what the fake engine says, to the clients that connect from now on. */
function speakForTheEngine(): (event: object) => void {
  let say: (event: object) => void = () => {};
  server.use(
    engine.addEventListener("connection", ({ client }) => {
      say = event => client.send(JSON.stringify(event));
    })
  );
  return event => say(event);
}

/** What the clients that connect from now on ask of the engine, but for their heartbeats. */
function requestsToTheEngine(): ExecutionRequest[] {
  const requests: ExecutionRequest[] = [];
  server.use(
    engine.addEventListener("connection", ({ client }) => {
      client.addEventListener("message", event => {
        const request = JSON.parse(event.data as string) as ExecutionRequest;
        if (request.type !== "HeartBeatRequest") requests.push(request);
      });
    })
  );
  return requests;
}

/**
 * The unit refuses the first page asked for from now on, as one whose result it could not read, in its words. The
 * page is not read, so the fake engine does not answer it.
 */
function firstPageRefused(message: string) {
  let refused = false;
  server.use(
    engine.addEventListener("connection", ({ client }) => {
      client.addEventListener("message", event => {
        const request = JSON.parse(event.data as string) as ExecutionRequest;
        if (refused || request.type !== "ResultPaginationRequest") return;
        refused = true;
        event.stopPropagation();
        client.send(JSON.stringify({ type: "RequestRefusedEvent", request: request.type, message }));
      });
    })
  );
}

/** What an operator printed, line by line, as the engine tells it. */
const printed = (operatorId: string, ...lines: string[]) => ({
  type: "ConsoleUpdateEvent",
  operatorId,
  messages: lines.map(line => ({ msgType: { name: "PRINT" }, title: line, message: line })),
});

/** An operator's result of so many rows, as the engine tells it. */
const rowsOf = (operatorId: string, rows: number) => ({
  type: "WebResultUpdateEvent",
  updates: { [operatorId]: { mode: { type: "PaginationMode" }, totalNumTuples: rows } },
});

/** The operators running, as the engine tells it. */
const running = (...operatorIds: string[]) => ({
  type: "OperatorStatisticsUpdateEvent",
  operatorStatistics: Object.fromEntries(
    operatorIds.map(id => [
      id,
      { operatorState: "Running", aggregatedInputRowCount: 0, aggregatedOutputRowCount: 0, numWorkers: 1 },
    ])
  ),
});

/** Drops the sockets that are open to the engine from now on, as a network that fails, or a unit that restarts. */
function engineConnections(): { drop: () => void } {
  const open: { close: () => void }[] = [];
  server.use(engine.addEventListener("connection", ({ client }) => void open.push(client)));
  return { drop: () => open.splice(0).forEach(client => client.close()) };
}

/** How many times the service has been asked where an execution stands. */
function questionsToTheService(): { count: number } {
  const asked = { count: 0 };
  server.use(
    http.get("/api/executions/:eid/state", () => {
      asked.count += 1;
    })
  );
  return asked;
}

/** A start that the service answers only once the test lets it. */
function heldStarts(): () => void {
  let answer = () => {};
  const answered = new Promise<void>(resolve => (answer = resolve));
  server.use(http.post("/api/executions", () => answered));
  return answer;
}

/** Fakes the clock from now on, as it goes on running: the client asks the service and connects again on it. */
const fakeClock = () =>
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

/** The execution the fake backend recorded last. */
const latestExecution = () => db.executionRecords.at(-1)!;

beforeEach(() => {
  signInAs(admin);
  db.files["penguins.csv"] = penguins;
  wid = addWorkflow(db, { name: "Heavy penguins" }).wid;
  cuid = addComputingUnit(db, { name: "Small unit" }).cuid;
});
afterEach(() => vi.useRealTimers());

describe("ExecutionClient", () => {
  it("is told that nothing has been executed yet when it connects", async () => {
    const client = await connect();

    expect(client.snapshot()).toMatchObject({ state: "Uninitialized", operators: {}, results: {}, errors: [] });
  });

  it("is told nothing by a unit the user may not use, whose socket closes before it opens", async () => {
    const theirs = addComputingUnit(db, { name: "Theirs", ownerUid: reader.uid }).cuid;
    let closed = 0;
    server.use(
      engine.addEventListener("connection", ({ client }) => client.addEventListener("close", () => (closed += 1)))
    );
    const client = new ExecutionClient(wid, theirs);
    onTestFinished(() => client.close());

    client.connect();

    await vi.waitFor(() => expect(closed).toBe(1));
    expect(client.snapshot()).toMatchObject({ connected: false, state: "Uninitialized" });
  });

  it("follows an execution to its end: each operator's rows, and the results that were kept", async () => {
    const client = await connect();

    const started = client.start(plan, defaultSettings);
    expect(client.snapshot().state).toBe("Initializing");
    await started;

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    expect(client.snapshot().operators).toEqual({
      scan: { state: "Completed", inputRows: 0, outputRows: 3 },
      filter: { state: "Completed", inputRows: 3, outputRows: 2 },
      limit: { state: "Completed", inputRows: 2, outputRows: 2 },
    });
    expect(client.snapshot().results).toEqual({ limit: { kind: "table", totalRows: 2, revision: 1 } });
    expect(client.snapshot().executionId).toBe(latestExecution().eid);
  });

  it("asks the service to create the execution, which its unit starts, with the plan and where it goes", async () => {
    let body: unknown;
    server.use(
      http.post("/api/executions", async ({ request }) => {
        body = await request.clone().json();
      })
    );
    const client = await connect();

    await client.start(logicalPlan(workflowContent([limit])), defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));

    expect(body).toEqual({
      wid,
      executionName: "",
      engineVersion: "",
      logicalPlan: logicalPlan(workflowContent([limit])),
      workflowSettings: defaultSettings,
      emailNotificationEnabled: false,
      computingUnitId: cuid,
    });
  });

  it("executes up to an operator with only what it needs, and keeps the result of each one that is marked to keep it", async () => {
    let body: unknown;
    server.use(
      http.post("/api/executions", async ({ request }) => {
        body = await request.clone().json();
      })
    );
    const content = workflowContent(
      [{ ...scan, viewResult: true }, filter, limit],
      [link("scan", "filter"), link("filter", "limit")]
    );
    const client = await connect();

    await client.start(logicalPlan(content, "filter"), defaultSettings);

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    expect(Object.keys(client.snapshot().operators)).toEqual(["scan", "filter"]);
    expect(client.snapshot().results).toEqual({
      scan: { kind: "table", totalRows: 3, revision: 1 },
      filter: { kind: "table", totalRows: 2, revision: 1 },
    });
    // The service is told no target of its own: its cut would keep the target's result and no other.
    expect(body).toMatchObject({ logicalPlan: logicalPlan(content, "filter") });
    expect(body).not.toHaveProperty("targetOperatorId");
  });

  it("pages through an operator's result", async () => {
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));

    await expect(client.page("limit", 1, 1)).resolves.toEqual({
      rows: [{ species: "Adelie", mass: 3750 }],
      columns: penguins.columns,
    });
    await expect(client.page("limit", 2, 1)).resolves.toEqual({
      rows: [{ species: "Gentoo", mass: 5000 }],
      columns: penguins.columns,
    });
  });

  it("fails a page that the unit could not read, with why, and not what was asked of the execution", async () => {
    const why = "The request failed on this computing unit: the lake that keeps the results did not answer.";
    firstPageRefused(why);
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));

    let failure: unknown;
    client.page("limit", 1, 1).catch((error: unknown) => (failure = error));
    const next = client.page("limit", 2, 1);

    // The unit answers in the order it was asked: the refusal comes before the next page.
    await expect(next).resolves.toEqual({ rows: [{ species: "Gentoo", mass: 5000 }], columns: penguins.columns });
    expect(failure).toEqual(new Error(why));
    expect(client.snapshot()).toMatchObject({ state: "Completed", notice: undefined });
  });

  it("says why an execution failed, and which operator it was about", async () => {
    const client = await connect();
    db.files = {};

    await client.start(plan, defaultSettings);

    expect(client.snapshot().state).toBe("Failed");
    expect(client.snapshot().errors).toEqual([
      { message: "java.io.FileNotFoundException: penguins.csv", operatorId: "scan" },
    ]);
  });

  it("puts each operator's error on its operator when the workflow does not compile, upstream operators first", async () => {
    const compileError = (operatorId: string, message: string, details = "") => ({
      type: { name: "COMPILATION_ERROR" },
      timestamp: { seconds: 1_795_000_000, nanos: 0 },
      message,
      details,
      operatorId,
      workerId: "",
    });
    server.use(
      http.post("/api/executions", () =>
        HttpResponse.json(
          {
            code: 400,
            message: "The workflow does not compile: 3 operators have errors.",
            eid: 12,
            // The answer keys the errors by operator, in no order.
            operatorErrors: {
              limit: compileError("limit", "scala.MatchError: null"),
              udf: compileError("udf", "SyntaxError: invalid syntax"),
              scan: compileError("scan", "java.io.FileNotFoundException: penguins.csv", "at CSVScanSourceOpExec"),
            },
          },
          { status: 400 }
        )
      )
    );
    // The plan lists its operators downstream first, as a canvas lists them in the order they were added.
    const backwards = logicalPlan(
      workflowContent([limit, filter, scan], [link("scan", "filter"), link("filter", "limit")])
    );
    const client = await connect();

    await client.start(backwards, defaultSettings);

    expect(client.snapshot().state).toBe("Failed");
    // The plan's operators come first, each after those it reads from; an operator the plan does not have, last.
    expect(client.snapshot().errors).toEqual([
      { message: "java.io.FileNotFoundException: penguins.csv", details: "at CSVScanSourceOpExec", operatorId: "scan" },
      { message: "scala.MatchError: null", operatorId: "limit" },
      { message: "SyntaxError: invalid syntax", operatorId: "udf" },
    ]);
  });

  it("names the warehouse an execution keeps its results in, which a deployment with warehouses asks for", async () => {
    db.warehouses = [{ whid: 4, name: "default" }];
    const client = await connect();

    await client.start(plan, defaultSettings);
    expect(client.snapshot().state).toBe("Failed");
    expect(client.snapshot().errors).toEqual([{ message: "A warehouse must be selected for this execution." }]);

    await client.start(plan, defaultSettings, 4);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
  });

  /** A start of the workflow, on the unit and under the settings, that is refused, and why. */
  interface Refused {
    workflowId?: number;
    unitId?: number;
    settings?: WorkflowSettings;
    message: string;
  }

  it.each<[string, () => Refused]>([
    [
      "a workflow the user may not read",
      () => {
        const theirs = addWorkflow(db, { name: "Theirs", ownerUid: reader.uid }).wid;
        return { workflowId: theirs, message: `You do not have access to workflow ${theirs}.` };
      },
    ],
    [
      "a unit the user may not execute workflows on",
      () => {
        // One the user may only read: its socket opens, and the service is what refuses the start.
        const theirs = addComputingUnit(db, {
          name: "Theirs",
          ownerUid: reader.uid,
          grants: [{ uid: admin.uid, privilege: "READ" }],
        }).cuid;
        return { unitId: theirs, message: `You may not run workflows on computing unit ${theirs}.` };
      },
    ],
    [
      "a unit that is terminated",
      () => {
        db.computingUnits = [];
        return { message: `Computing unit ${cuid} is terminated.` };
      },
    ],
    [
      "settings no plan can be made under",
      () => ({
        settings: { ...defaultSettings, dataTransferBatchSize: 0 },
        message: "The workflow's Data Transfer Batch Size is 0; set it to 1 or more.",
      }),
    ],
  ])("says why the service refuses to start an execution: %s", async (_, setUp) => {
    const { workflowId = wid, unitId = cuid, settings = defaultSettings, message } = setUp();
    const client = await connect(workflowId, unitId);

    await client.start(plan, settings);

    expect(client.snapshot()).toMatchObject({ state: "Failed", errors: [{ message }] });
    expect(db.executionRecords).toEqual([]);
  });

  it.each([
    ["a unit that cannot be reached", 503, "Execution 4 could not be started: computing unit 1 could not be reached."],
    ["a unit that did not say whether it started it", 504, tooSlow],
  ])("says why the service did not start an execution: %s", async (_, status, message) => {
    server.use(http.post("/api/executions", () => HttpResponse.json({ code: status, message }, { status })));
    const client = await connect();

    await client.start(plan, defaultSettings);

    expect(client.snapshot().state).toBe("Failed");
    expect(client.snapshot().errors).toEqual([{ message }]);
  });

  it.each([
    ["no answer", () => HttpResponse.error(), "The Dashboard service could not be reached."],
    [
      "a gateway that takes no workflow so large",
      () => HttpResponse.html("<h1>413 Request Entity Too Large</h1>", { status: 413 }),
      "The workflow is larger than this deployment accepts in one request.",
    ],
    [
      "a gateway's page of its own",
      () => HttpResponse.html("<h1>502 Bad Gateway</h1>", { status: 502 }),
      "The Dashboard service answered 502.",
    ],
  ])("says what became of a start that the service did not answer itself: %s", async (_, response, message) => {
    server.use(http.post("/api/executions", response));
    const client = await connect();

    await client.start(plan, defaultSettings);

    expect(client.snapshot().state).toBe("Failed");
    expect(client.snapshot().errors).toEqual([{ message }]);
  });

  it("leaves the execution its unit names as it is when the service could not say it started it, and says so", async () => {
    const say = speakForTheEngine();
    const client = await connect();
    server.use(
      http.post("/api/executions", async () => {
        // The unit started the execution, and says so before the service gives up waiting for its answer.
        say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });
        await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
        return HttpResponse.json({ code: 504, message: tooSlow }, { status: 504 });
      })
    );

    await client.start(plan, defaultSettings);

    expect(client.snapshot()).toMatchObject({ state: "Running", executionId: 4, errors: [], notice: tooSlow });
  });

  it("drops why a start seemed to fail once its unit shows the execution under way", async () => {
    const say = speakForTheEngine();
    server.use(http.post("/api/executions", () => HttpResponse.json({ code: 504, message: tooSlow }, { status: 504 })));
    const client = await connect();
    await client.start(plan, defaultSettings);
    expect(client.snapshot()).toMatchObject({ state: "Failed", errors: [{ message: tooSlow }] });

    say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });

    await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ state: "Running", executionId: 4, errors: [] }));
  });

  it.each([
    ["names no execution", () => HttpResponse.json({}, { status: 201 })],
    ["is null", () => HttpResponse.json(null, { status: 201 })],
    [
      "is not JSON",
      () => new HttpResponse("created", { status: 201, headers: { "Content-Type": "application/json" } }),
    ],
  ])("takes a start the service says it created, in an answer that %s, as one its unit names", async (_, response) => {
    const requests = requestsToTheEngine();
    const say = speakForTheEngine();
    server.use(http.post("/api/executions", response));
    const client = await connect();

    const started = client.start(plan, defaultSettings);
    client.kill();
    await started;

    // A stop asked for meanwhile cannot name it.
    expect(client.snapshot()).toMatchObject({
      state: "Initializing",
      executionId: undefined,
      errors: [],
      notice: "The execution was created, but the Dashboard service did not say which it is, so it was not stopped.",
    });
    say({ type: "WorkflowStateEvent", state: "Running", executionId: 9 });
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    client.pause();
    await vi.waitFor(() => expect(requests).toEqual([{ type: "WorkflowPauseRequest", executionId: 9 }]));
  });

  it("pauses, resumes and stops an execution that is under way, naming it in each request", async () => {
    db.executionMs = 60_000;
    const requests = requestsToTheEngine();
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    expect(client.snapshot().operators.scan).toEqual({ state: "Running", inputRows: 0, outputRows: 0 });

    client.pause();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Paused"));
    client.resume();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    client.kill();
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Killed"));

    const { eid } = latestExecution();
    expect(requests).toEqual([
      { type: "WorkflowPauseRequest", executionId: eid },
      { type: "WorkflowResumeRequest", executionId: eid },
      { type: "WorkflowKillRequest", executionId: eid },
    ]);
    expect(latestExecution()).toMatchObject({ status: 5, reason: "killed by the user" });
  });

  it("names the execution the service created in what it asks, before its unit has named it", async () => {
    const requests = requestsToTheEngine();
    // The service creates execution 42, whose unit has not said a word of it yet.
    server.use(http.post("/api/executions", () => HttpResponse.json({ eid: 42 }, { status: 201 })));
    const client = await connect();

    await client.start(plan, defaultSettings);
    expect(client.snapshot()).toMatchObject({ state: "Initializing", executionId: 42 });
    client.pause();
    client.kill();

    await vi.waitFor(() =>
      expect(requests).toEqual([
        { type: "WorkflowPauseRequest", executionId: 42 },
        { type: "WorkflowKillRequest", executionId: 42 },
      ])
    );
  });

  it("stops an execution asked to stop before the service has created it, once it has, and not the one before", async () => {
    const requests = requestsToTheEngine();
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    const before = latestExecution();
    db.executionMs = 60_000;
    // The service takes its time to create the next execution: the stop is asked for before it answers.
    const answer = heldStarts();

    const started = client.start(plan, defaultSettings);
    client.kill();
    expect(client.snapshot().state).toBe("Initializing");
    answer();
    await started;

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Killed"));
    const after = latestExecution();
    expect(requests).toEqual([{ type: "WorkflowKillRequest", executionId: after.eid }]);
    expect([before.status, after.status]).toEqual([3, 5]);
  });

  it("shows a start as under way until something names it, whatever a socket that opens meanwhile is told", async () => {
    db.executionMs = 60_000;
    const say = speakForTheEngine();
    const client = await connect();
    const answer = heldStarts();
    const started = client.start(plan, defaultSettings);

    // What every new socket is told first, as one that opens while the service creates the execution is.
    say({ type: "WorkflowStateEvent", state: "Uninitialized" });
    // The page is answered on the same socket after it, so the state of no execution has come by then.
    await client.page("limit", 1, 1);

    expect(client.snapshot().state).toBe("Initializing");
    client.kill();
    answer();
    await started;
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Killed"));
  });

  it("stops an execution asked to stop while it was created, once the socket that dropped meanwhile is back", async () => {
    db.executionMs = 60_000;
    const requests = requestsToTheEngine();
    const connections = engineConnections();
    const client = await connect();
    const answer = heldStarts();
    const started = client.start(plan, defaultSettings);
    client.kill();
    fakeClock();

    connections.drop();
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(false));
    answer();
    await started;

    // Nothing could be sent; the service is asked about the execution while its unit cannot show it.
    expect(requests).toEqual([]);
    expect(client.snapshot()).toMatchObject({ state: "Initializing", followedAtDashboard: true });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Killed"));
    expect(requests).toEqual([{ type: "WorkflowKillRequest", executionId: latestExecution().eid }]);
    expect(client.snapshot().followedAtDashboard).toBe(false);
  });

  it("stops an execution that someone else started, as its unit names it", async () => {
    db.executionMs = 60_000;
    const requests = requestsToTheEngine();
    const mine = await connect();
    const theirs = await connect();
    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Running"));

    theirs.kill();

    await vi.waitFor(() => expect(mine.snapshot().state).toBe("Killed"));
    expect(requests).toEqual([{ type: "WorkflowKillRequest", executionId: latestExecution().eid }]);
  });

  it("leaves an execution that has ended as it ended when it is asked to stop", async () => {
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));

    client.kill();
    // The page is asked for after the stop, on the same socket, so the stop has been read when it comes.
    await client.page("limit", 1, 1);

    expect(client.snapshot()).toMatchObject({ state: "Completed", notice: undefined });
    expect(latestExecution().status).toBe(3);
  });

  it("tells whoever asked why the unit refused a request, apart from the execution's errors, until a start", async () => {
    const client = await connect();
    const theirs = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    const other = latestExecution().eid + 1;

    // An execution the unit does not hold, such as one that another start replaced.
    client.kill(other);

    await vi.waitFor(() => expect(client.snapshot().notice).toBe(`Execution ${other} is not running here.`));
    expect(client.snapshot()).toMatchObject({ state: "Completed", errors: [] });
    expect(theirs.snapshot().notice).toBeUndefined();
    const started = client.start(plan, defaultSettings);
    expect(client.snapshot().notice).toBeUndefined();
    await started;
  });

  it("leaves a newer execution as it is when a stop of the one it replaced is refused", async () => {
    db.executionMs = 60_000;
    const mine = await connect();
    const theirs = await connect();
    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Running"));
    const replaced = latestExecution().eid;

    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().executionId).toBe(latestExecution().eid));
    // They stop the execution they saw last, which the unit no longer holds.
    theirs.kill(replaced);

    await vi.waitFor(() => expect(theirs.snapshot().notice).toBe(`Execution ${replaced} is not running here.`));
    expect(theirs.snapshot()).toMatchObject({ state: "Running", executionId: latestExecution().eid, errors: [] });
  });

  it("says why the unit refuses a stop from someone who may not change what it executes", async () => {
    db.executionMs = 60_000;
    db.resources
      .find(resource => resource.type === "computing-unit" && resource.id === cuid)!
      .grants.push({ uid: reader.uid, privilege: "READ" });
    const mine = await connect();
    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(mine.snapshot().state).toBe("Running"));
    signInAs(reader);
    const theirs = await connect();
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Running"));

    theirs.kill();

    await vi.waitFor(() =>
      expect(theirs.snapshot().notice).toBe("You do not have write access to the computing unit.")
    );
    expect(mine.snapshot()).toMatchObject({ state: "Running", notice: undefined });
  });

  it("replaces the workflow's execution that is under way, which is recorded as killed in its place", async () => {
    db.executionMs = 60_000;
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    const first = latestExecution();

    await client.start(plan, defaultSettings);

    await vi.waitFor(() =>
      expect(client.snapshot()).toMatchObject({ state: "Running", executionId: latestExecution().eid })
    );
    expect(first).toMatchObject({ status: 5, reason: `replaced by execution ${latestExecution().eid}` });
  });

  it("keeps an execution on screen that its unit stops showing, and shows where the service says it stands", async () => {
    db.executionMs = 60_000;
    const say = speakForTheEngine();
    const asked = questionsToTheService();
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    fakeClock();

    // All that a unit which has lost the execution says.
    say({ type: "WorkflowStateEvent", state: "Uninitialized" });

    await vi.waitFor(() => expect(client.snapshot().followedAtDashboard).toBe(true));
    expect(client.snapshot()).toMatchObject({ state: "Running", executionId: undefined });
    await vi.advanceTimersByTimeAsync(dashboardFollowMs);
    await vi.waitFor(() => expect(asked.count).toBe(1));
    expect(client.snapshot().state).toBe("Running");
    // The service has closed it since, as its unit was lost.
    Object.assign(latestExecution(), { status: 4, reason: "unit lost", closed: true });
    await vi.advanceTimersByTimeAsync(dashboardFollowMs);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Failed"));
    expect(client.snapshot()).toMatchObject({ errors: [{ message: "unit lost" }], followedAtDashboard: false });
  });

  it("asks the service again when it does not answer where an execution stands, or answers what cannot be read", async () => {
    db.executionMs = 60_000;
    const say = speakForTheEngine();
    let asked = 0;
    server.use(
      http.get("/api/executions/:eid/state", () => {
        asked += 1;
        if (asked === 1) return HttpResponse.json({ code: 503, message: "Try again." }, { status: 503 });
        if (asked === 2) return HttpResponse.json({ eid: 1 });
      })
    );
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    fakeClock();
    say({ type: "WorkflowStateEvent", state: "Uninitialized" });
    await vi.waitFor(() => expect(client.snapshot().followedAtDashboard).toBe(true));

    for (const answers of [1, 2]) {
      await vi.advanceTimersByTimeAsync(dashboardFollowMs);
      await vi.waitFor(() => expect(asked).toBe(answers));
      expect(client.snapshot()).toMatchObject({ state: "Running", followedAtDashboard: true });
    }
    Object.assign(latestExecution(), { status: 3, closed: true });
    await vi.advanceTimersByTimeAsync(dashboardFollowMs);

    await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ state: "Completed", followedAtDashboard: false }));
  });

  it.each<[number, ExecutionState]>([
    [0, "Initializing"],
    [1, "Running"],
    [2, "Paused"],
    // Created and started by no unit yet, and a state that could not be read: neither says where it stands.
    [6, "Running"],
    [-1, "Running"],
    // An ending that the closing job has yet to record.
    [3, "Completed"],
    [4, "Failed"],
    [5, "Killed"],
  ])(
    "shows an execution its unit does not show where the service has it stand, %i, and asks until it is closed",
    async (status, shown) => {
      db.executionMs = 60_000;
      const say = speakForTheEngine();
      const asked = questionsToTheService();
      const client = await connect();
      await client.start(plan, defaultSettings);
      await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
      fakeClock();
      say({ type: "WorkflowStateEvent", state: "Uninitialized" });
      await vi.waitFor(() => expect(client.snapshot().followedAtDashboard).toBe(true));

      Object.assign(latestExecution(), { status });
      await vi.advanceTimersByTimeAsync(dashboardFollowMs);
      await vi.waitFor(() => expect(asked.count).toBe(1));
      // It is asked about again while it is open, once the answer before is shown.
      await vi.advanceTimersByTimeAsync(dashboardFollowMs);
      await vi.waitFor(() => expect(asked.count).toBe(2));
      expect(client.snapshot()).toMatchObject({ state: shown, followedAtDashboard: true });

      // The closing job closes it, as its unit was lost: it is not asked about again.
      Object.assign(latestExecution(), { status: 4, reason: "unit lost", closed: true });
      await vi.advanceTimersByTimeAsync(dashboardFollowMs);
      await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ state: "Failed", followedAtDashboard: false }));
      expect(client.snapshot().errors).toEqual([{ message: "unit lost" }]);
      await vi.advanceTimersByTimeAsync(2 * dashboardFollowMs);
      expect(asked.count).toBe(3);
    }
  );

  it("asks the service while the socket is down, and stops once the unit shows the execution again", async () => {
    db.executionMs = 60_000;
    const connections = engineConnections();
    const asked = questionsToTheService();
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    fakeClock();

    connections.drop();
    await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ connected: false, followedAtDashboard: true }));
    // The socket is back before the service is asked, and its unit still holds the execution.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ connected: true, followedAtDashboard: false }));
    await vi.advanceTimersByTimeAsync(dashboardFollowMs);

    expect(asked.count).toBe(0);
    expect(client.snapshot()).toMatchObject({ state: "Running", executionId: latestExecution().eid });
  });

  it("shows how an execution ended, as the service says, when its unit was lost while the socket was down", async () => {
    db.executionMs = 60_000;
    const connections = engineConnections();
    const client = await connect();
    await client.start(plan, defaultSettings);
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Running"));
    fakeClock();

    connections.drop();
    // The unit restarts without the execution, which the service closes as stopped.
    delete db.executions[wid];
    Object.assign(latestExecution(), { status: 5, reason: "unit terminated", closed: true });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    expect(client.snapshot()).toMatchObject({ state: "Running", followedAtDashboard: true });
    await vi.advanceTimersByTimeAsync(dashboardFollowMs);

    await vi.waitFor(() => expect(client.snapshot()).toMatchObject({ state: "Killed", followedAtDashboard: false }));
  });

  it("shows each line once when a socket that dropped is told again all the lines the unit keeps", async () => {
    const say = speakForTheEngine();
    const connections = engineConnections();
    const client = await connect();
    say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });
    say(printed("udf", "one"));
    say(printed("udf", "two"));
    await vi.waitFor(() => expect(client.snapshot().console.udf).toHaveLength(2));
    fakeClock();

    connections.drop();
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(false));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    // The new socket is told every line the unit keeps of the operator, then where the execution stands, then each
    // new line.
    say(printed("udf", "one", "two"));
    say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });
    say(printed("udf", "three"));

    await vi.waitFor(() =>
      expect(client.snapshot().console.udf.map(line => line.title)).toEqual(["one", "two", "three"])
    );
  });

  it("shows only what a socket that opens is told of the execution its unit holds, and nothing of the one before", async () => {
    const say = speakForTheEngine();
    const connections = engineConnections();
    const client = await connect();
    say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });
    say(running("scan", "filter", "limit"));
    say(rowsOf("limit", 2));
    say(printed("limit", "kept 2 rows"));
    say({ type: "WorkflowStateEvent", state: "Completed", executionId: 4 });
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    fakeClock();

    connections.drop();
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(false));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    // Someone executed the workflow up to the filter meanwhile: the new socket is told all the unit holds of that
    // execution, and then its state.
    say(rowsOf("filter", 2));
    say(running("scan", "filter"));
    say(printed("filter", "kept 2 rows"));
    say({ type: "WorkflowStateEvent", state: "Running", executionId: 5 });

    await vi.waitFor(() => expect(client.snapshot().executionId).toBe(5));
    expect(client.snapshot().results).toEqual({ filter: { kind: "table", totalRows: 2, revision: 1 } });
    expect(client.snapshot().console).toEqual({
      filter: [{ kind: "PRINT", title: "kept 2 rows", message: "kept 2 rows" }],
    });
    expect(Object.keys(client.snapshot().operators)).toEqual(["scan", "filter"]);
  });

  it("shows two people the same execution, and tells whoever connects later where it stands", async () => {
    db.executionMs = 60_000;
    const mine = await connect();
    const theirs = await connect();

    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Running"));

    const latecomer = await connect();
    await vi.waitFor(() => expect(latecomer.snapshot().state).toBe("Running"));
    expect(latecomer.snapshot().operators.scan.state).toBe("Running");

    db.executions[wid].finish();
    await vi.waitFor(() => expect(latecomer.snapshot().state).toBe("Completed"));
    expect(theirs.snapshot().results).toEqual(mine.snapshot().results);
  });

  it("shows nothing of the execution before once its unit names another, which someone else started", async () => {
    const mine = await connect();
    const say = speakForTheEngine();
    const theirs = await connect();
    await mine.start(plan, defaultSettings);
    await vi.waitFor(() => expect(theirs.snapshot().state).toBe("Completed"));
    say(printed("limit", "kept 2 rows"));
    await vi.waitFor(() => expect(theirs.snapshot().console).toHaveProperty("limit"));
    expect(theirs.snapshot().results).toHaveProperty("limit");
    db.executionMs = 60_000;

    // The workflow is executed up to the filter, which takes the place of the execution before on the unit.
    await mine.start(logicalPlan(workflowContent([scan, filter], [link("scan", "filter")])), defaultSettings);

    await vi.waitFor(() =>
      expect(theirs.snapshot()).toMatchObject({ state: "Running", executionId: latestExecution().eid })
    );
    expect(theirs.snapshot().results).toEqual({});
    expect(theirs.snapshot().console).toEqual({});
    expect(Object.keys(theirs.snapshot().operators)).toEqual(["scan", "filter"]);
  });

  it("says why an execution failed while it was executed, and which operator each error is about", async () => {
    const say = speakForTheEngine();
    const client = await connect();

    say({ type: "WorkflowStateEvent", state: "Running", executionId: 4 });
    say({
      type: "WorkflowErrorEvent",
      fatalErrors: [
        { message: "ZeroDivisionError: division by zero", details: "line 3", operatorId: "udf" },
        { message: "A worker was lost.", details: "", operatorId: "unknown operator" },
      ],
    });
    say({ type: "WorkflowStateEvent", state: "Failed", executionId: 4 });

    await vi.waitFor(() => expect(client.snapshot().state).toBe("Failed"));
    expect(client.snapshot().errors).toEqual([
      { message: "ZeroDivisionError: division by zero", details: "line 3", operatorId: "udf" },
      { message: "A worker was lost." },
    ]);
  });

  it("takes every operator as completed once the execution has, whatever the engine last said of it", async () => {
    const running = { operatorState: "Running", aggregatedInputRowCount: 2, aggregatedOutputRowCount: 2 };
    const say = speakForTheEngine();
    const client = await connect();

    // The engine's last word on the operator comes before its last word on the execution, and again after it.
    say({ type: "OperatorStatisticsUpdateEvent", operatorStatistics: { limit: running } });
    say({ type: "WorkflowStateEvent", state: "Completed", executionId: 4 });
    await vi.waitFor(() => expect(client.snapshot().state).toBe("Completed"));
    expect(client.snapshot().operators).toEqual({ limit: { state: "Completed", inputRows: 2, outputRows: 2 } });

    say({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { limit: { ...running, aggregatedOutputRowCount: 3 } },
    });
    await vi.waitFor(() => expect(client.snapshot().operators.limit.outputRows).toBe(3));
    expect(client.snapshot().operators.limit.state).toBe("Completed");
  });

  it("asks nothing once it is closed, also of a start that the service answers after that", async () => {
    db.executionMs = 60_000;
    const asked = questionsToTheService();
    const client = await connect();
    const answer = heldStarts();
    const started = client.start(plan, defaultSettings);
    fakeClock();

    // The page is left before the service has created the execution.
    client.close();
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(false));
    answer();
    await started;
    await vi.advanceTimersByTimeAsync(3 * dashboardFollowMs);

    expect(asked.count).toBe(0);
    expect(client.snapshot().followedAtDashboard).toBe(false);
  });

  it("tells its listeners of every change, and refuses a page while it is not connected", async () => {
    const client = new ExecutionClient(wid, cuid);
    const listener = vi.fn();
    client.subscribe(listener);

    await expect(client.page("limit", 1, 20)).rejects.toThrow("Not connected to the computing unit.");
    client.connect();
    onTestFinished(() => client.close());

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });
});
