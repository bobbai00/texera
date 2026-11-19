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

// The computing units (ComputingUnitManagingResource.scala) and the engine's socket on one of them
// (WorkflowWebsocketResource.scala). As on the real engine, everyone connected to a workflow is sent the same
// events, whoever starts connecting later is told where the execution stands, and a new execution replaces the
// one before it. What an execution computes comes from the stand-in engine in ./engine.ts.

import { ws } from "msw";
import { http, HttpResponse } from "msw/http";
import type { ExecutionEvent, ExecutionRequest, ExecutionState } from "@/lib/execution/protocol";
import type { LogicalPlan } from "@/lib/workflow/plan";
import { admin } from "../fixtures";
import { errorResponse, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import { evaluate, type MockTable } from "./engine";
import type { MockDb } from "./index";

/** A computing unit. Its owner, and who it is shared with, are in db.resources. */
export interface MockComputingUnit {
  cuid: number;
  name: string;
  /** In epoch milliseconds. */
  creationTime: number;
  /** As the unit's pod reports it: "Running", "Pending", "Failed", "Terminating" or "Unknown". */
  status: string;
  type: "kubernetes" | "local";
  /** What it was made with, as the service keeps it: "NaN" for each, for a local unit. */
  resource: { cpuLimit: string; memoryLimit: string; gpuLimit: string };
}

/** Adds a computing unit, running and owned by the admin unless told otherwise, and returns it. */
export function addComputingUnit(
  db: MockDb,
  seed: {
    name: string;
    status?: string;
    ownerUid?: number;
    type?: MockComputingUnit["type"];
    resource?: MockComputingUnit["resource"];
  }
): MockComputingUnit {
  const unit: MockComputingUnit = {
    cuid: Math.max(0, ...db.computingUnits.map(other => other.cuid)) + 1,
    name: seed.name,
    creationTime: Date.UTC(2026, 10, 12, 12),
    status: seed.status ?? "Running",
    type: seed.type ?? "local",
    resource: seed.resource ?? { cpuLimit: "NaN", memoryLimit: "NaN", gpuLimit: "NaN" },
  };
  db.computingUnits.push(unit);
  db.resources.push({
    type: "computing-unit",
    id: unit.cuid,
    ownerUid: seed.ownerUid ?? admin.uid,
    isPublic: false,
    grants: [],
  });
  return unit;
}

/** A workflow's execution on the fake engine: the one slot that a real unit has for each workflow too. */
export interface MockExecution {
  state: ExecutionState;
  /** What every client is told again when it connects: the events that say where the execution stands. */
  standing: ExecutionEvent[];
  outputs: Record<string, MockTable | undefined>;
  /** Ends the wait of an execution that db.executionMs holds in "Running". */
  finish: () => void;
}

/**
 * What the backend keeps of an execution (workflow_executions), as it lists it. Its status is the engine's code
 * (Utils.maptoStatusCode): 0 initializing, 1 running, 2 paused, 3 completed, 4 failed, 5 killed.
 */
export interface MockExecutionRecord {
  eid: number;
  wid: number;
  /** The newest version of the workflow when the execution started. */
  vid: number;
  uid: number;
  cuid: number;
  status: number;
  name: string;
  startingTime: number;
  lastUpdateTime: number | null;
  bookmarked: boolean;
  /** Its runtime statistics: each operator's running totals, sampled while it ran. */
  statistics: MockStatistics[];
  /** How much of its results, statistics and logs the backend keeps, in bytes. */
  kept: { resultBytes: number; runTimeStatsBytes: number; logBytes: number };
}

export interface MockStatistics {
  operatorId: string;
  timestamp: number;
  inputTupleCount: number;
  outputTupleCount: number;
  dataProcessingTime: number;
  controlProcessingTime: number;
  idleTime: number;
  numWorkers: number;
  status: number;
}

const statusCodes: Partial<Record<ExecutionState, number>> = {
  Initializing: 0,
  Running: 1,
  Paused: 2,
  Completed: 3,
  Failed: 4,
  Killed: 5,
};

/** Adds an execution to a workflow's history, as if it had been executed, and returns it. */
export function addExecutionRecord(
  db: MockDb,
  seed: Partial<MockExecutionRecord> & { wid: number }
): MockExecutionRecord {
  const record: MockExecutionRecord = {
    eid: Math.max(0, ...db.executionRecords.map(other => other.eid)) + 1,
    vid: 1,
    uid: admin.uid,
    cuid: 1,
    status: 3,
    name: "Untitled Execution",
    startingTime: Date.UTC(2026, 10, 18, 10, 0),
    lastUpdateTime: Date.UTC(2026, 10, 18, 10, 0, 12),
    bookmarked: false,
    statistics: [],
    kept: { resultBytes: 0, runTimeStatsBytes: 0, logBytes: 0 },
    ...seed,
  };
  db.executionRecords.push(record);
  return record;
}

interface Client {
  send: (data: string) => void;
}

export function executionHandlers(db: MockDb) {
  const engine = ws.link(/\/wsapi\/workflow-websocket/);
  const workflowResource = (wid: number) =>
    db.resources.find(resource => resource.type === "workflow" && resource.id === wid) ?? {
      type: "workflow" as const,
      id: wid,
      ownerUid: -1,
      isPublic: false,
      grants: [],
    };
  // Who is connected to each workflow. Sockets are not records: they end with their test, not with a reset.
  const clients = new Map<number, Set<Client>>();

  function broadcast(wid: number, event: ExecutionEvent, standing = true) {
    if (standing) db.executions[wid]?.standing.push(event);
    for (const client of clients.get(wid) ?? []) client.send(JSON.stringify(event));
  }

  function setState(wid: number, state: ExecutionState) {
    db.executions[wid].state = state;
    const record = db.executionRecords.findLast(each => each.wid === wid);
    if (record && state in statusCodes)
      Object.assign(record, { status: statusCodes[state], lastUpdateTime: Date.now() });
    broadcast(wid, { type: "WorkflowStateEvent", state });
  }

  async function execute(wid: number, plan: LogicalPlan, warehouseId: number | undefined, uid: number, cuid: number) {
    db.executions[wid]?.finish();
    const { outputs, errors } = evaluate(plan, db.files);
    const execution: MockExecution = { state: "Initializing", standing: [], outputs, finish: () => {} };
    db.executions[wid] = execution;
    // The backend records each execution with the newest version of the workflow when it starts.
    const record = addExecutionRecord(db, {
      wid,
      vid: db.workflows.find(workflow => workflow.wid === wid)?.saves.length ?? 1,
      uid,
      cuid,
      status: 0,
      startingTime: Date.now(),
      lastUpdateTime: null,
    });
    const ids = plan.operators.map(operator => operator.operatorID as string);
    const statistics = (state: string, done: boolean) => ({
      type: "OperatorStatisticsUpdateEvent" as const,
      operatorStatistics: Object.fromEntries(
        ids.map(id => {
          const inputs = plan.links
            .filter(link => link.toOpId === id)
            .map(link => outputs[link.fromOpId]?.rows.length ?? 0);
          const rows = (count: number) => (done ? count : 0);
          return [
            id,
            {
              operatorState: state,
              aggregatedInputRowCount: rows(inputs.reduce((sum, count) => sum + count, 0)),
              aggregatedOutputRowCount: rows(outputs[id]?.rows.length ?? 0),
              numWorkers: 1,
            },
          ];
        })
      ),
    });

    setState(wid, "Initializing");
    // A deployment with warehouses keeps an execution's results in one, so it refuses an execution without.
    if (db.warehouses && !db.warehouses.some(warehouse => warehouse.whid === warehouseId)) {
      const message = "java.lang.IllegalArgumentException: a warehouse must be selected for this execution";
      broadcast(wid, {
        type: "WorkflowErrorEvent",
        fatalErrors: [{ message, details: "", operatorId: "unknown operator" }],
      });
      setState(wid, "Failed");
      return;
    }
    if (Object.keys(errors).length > 0) {
      const fatalErrors = Object.entries(errors).map(([operatorId, message]) => ({ message, details: "", operatorId }));
      // The engine reports a failure through its errors; the state event that follows says "Failed" too.
      broadcast(wid, { type: "WorkflowErrorEvent", fatalErrors });
      setState(wid, "Failed");
      return;
    }
    setState(wid, "Running");
    broadcast(wid, statistics("Running", false));
    if (db.executionMs > 0) {
      await new Promise<void>(resolve => {
        execution.finish = resolve;
        setTimeout(resolve, db.executionMs);
      });
    }
    // Killed, or replaced by a newer execution, while it ran: nothing more is said about it.
    if (db.executions[wid] !== execution || execution.state === "Killed") return;

    execution.standing = execution.standing.filter(event => event.type !== "OperatorStatisticsUpdateEvent");
    broadcast(wid, statistics("Completed", true));
    record.statistics = ids.map(id => ({
      operatorId: id,
      timestamp: Date.now(),
      inputTupleCount: plan.links
        .filter(link => link.toOpId === id)
        .reduce((sum, link) => sum + (outputs[link.fromOpId]?.rows.length ?? 0), 0),
      outputTupleCount: outputs[id]?.rows.length ?? 0,
      dataProcessingTime: 2_000_000,
      controlProcessingTime: 500_000,
      idleTime: 0,
      numWorkers: 1,
      status: 3,
    }));
    // The engine keeps the output of the operators marked for viewing, and of those nothing reads from.
    const kept = ids.filter(id => plan.opsToViewResult.includes(id) || !plan.links.some(link => link.fromOpId === id));
    broadcast(wid, {
      type: "WebResultUpdateEvent",
      updates: Object.fromEntries(
        kept.flatMap(id => {
          const table = outputs[id];
          if (!table) return [];
          const isVisualization = table.columns.length === 1 && table.columns[0].attributeName === "html-content";
          return [
            [
              id,
              isVisualization
                ? { mode: { type: "SetSnapshotMode" as const }, table: table.rows }
                : { mode: { type: "PaginationMode" as const }, totalNumTuples: table.rows.length },
            ],
          ];
        })
      ),
    });
    setState(wid, "Completed");
  }

  return [
    // GET /computing-unit -> the units the user owns or that are shared with them, each with its status.
    http.get("/api/computing-unit", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.computingUnits.flatMap(unit => {
          const resource = db.resources.find(
            candidate => candidate.type === "computing-unit" && candidate.id === unit.cuid
          )!;
          const privilege = privilegeOf(resource, user.uid);
          if (privilege === "NONE") return [];
          const owner = db.users.find(candidate => candidate.uid === resource.ownerUid)!;
          const { cuid, name, creationTime, status, type, resource: limits } = unit;
          return [
            {
              computingUnit: {
                cuid,
                uid: owner.uid,
                name,
                creationTime,
                type,
                uri: "",
                resource: JSON.stringify(limits),
              },
              status,
              statusReason: null,
              isOwner: owner.uid === user.uid,
              accessPrivilege: privilege,
              ownerAvatar: "",
              ownerName: owner.name,
            },
          ];
        })
      );
    }),

    // GET /computing-unit/types -> the kinds of unit this deployment makes.
    http.get("/api/computing-unit/types", () => HttpResponse.json({ typeOptions: db.unitTypes })),

    // GET /computing-unit/limits -> what a unit of the cluster may have.
    http.get("/api/computing-unit/limits", () =>
      HttpResponse.json({
        cpuLimitOptions: ["1", "2", "4"],
        memoryLimitOptions: ["1Gi", "2Gi", "4Gi"],
        gpuLimitOptions: ["0", "1"],
      })
    ),

    // POST /computing-unit/create {name, unitType, cpuLimit, ...} -> the new unit. The service refuses a type it
    // does not make, a name that is empty, and a limit it does not offer, all with 403.
    http.post("/api/computing-unit/create", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const body = (await request.json()) as {
        name: string;
        unitType: MockComputingUnit["type"];
        cpuLimit: string;
        memoryLimit: string;
        gpuLimit: string;
      };
      if (!db.unitTypes.includes(body.unitType))
        return errorResponse(403, `Unit type ${body.unitType} is not supported.`);
      if (!body.name.trim()) return errorResponse(403, "Name of the computing unit cannot be empty.");
      const unit = addComputingUnit(db, {
        name: body.name,
        ownerUid: user.uid,
        status: body.unitType === "kubernetes" ? "Pending" : "Running",
        type: body.unitType,
        resource: { cpuLimit: body.cpuLimit, memoryLimit: body.memoryLimit, gpuLimit: body.gpuLimit },
      });
      return HttpResponse.json({ computingUnit: { cuid: unit.cuid, name: unit.name }, status: unit.status });
    }),

    // DELETE /computing-unit/{cuid}/terminate: ends the unit, if the user owns it; anyone else gets 400.
    http.delete<{ cuid: string }>("/api/computing-unit/:cuid/terminate", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const cuid = Number(params.cuid);
      const resource = db.resources.find(each => each.type === "computing-unit" && each.id === cuid);
      if (!resource || (resource.ownerUid !== user.uid && user.role !== "ADMIN")) {
        return errorResponse(400, "Only the owner may terminate it.");
      }
      db.computingUnits = db.computingUnits.filter(unit => unit.cuid !== cuid);
      return new HttpResponse(null, { status: 200 });
    }),

    // GET /warehouse/status -> whether the deployment has warehouses, and the user's.
    http.get("/api/warehouse/status", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json({ enabled: db.warehouses !== undefined, warehouses: db.warehouses ?? [] });
    }),

    // GET /executions/{wid} -> the workflow's executions, newest first, to whoever may see it; nobody else is told
    // of any (WorkflowExecutionsResource.retrieveExecutionsOfWorkflow).
    http.get<{ wid: string }>("/api/executions/:wid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const wid = Number(params.wid);
      if (privilegeOf(workflowResource(wid), user.uid) === "NONE") return HttpResponse.json([]);
      return HttpResponse.json(
        db.executionRecords
          .filter(record => record.wid === wid)
          .toSorted((a, b) => b.eid - a.eid)
          .map(record => ({
            eId: record.eid,
            vId: record.vid,
            cuId: record.cuid,
            whId: null,
            userName: db.users.find(each => each.uid === record.uid)?.name ?? "",
            avatar: null,
            status: record.status,
            result: null,
            startingTime: record.startingTime,
            completionTime: record.lastUpdateTime,
            bookmarked: record.bookmarked,
            name: record.name,
            logLocation: null,
          }))
      );
    }),

    // GET /executions/{wid}/latest -> the workflow's latest execution, with the unit it was executed on.
    http.get<{ wid: string }>("/api/executions/:wid/latest", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const record = db.executionRecords.findLast(each => each.wid === Number(params.wid));
      if (!record) return errorResponse(403, "Executions doesn't exist");
      return HttpResponse.json({ eId: record.eid, vId: record.vid, cuId: record.cuid, status: record.status });
    }),

    // GET /executions/{wid}/stats/{eid} -> the execution's runtime statistics. One that has none is a 500, as
    // on the server, which then finds no document to read.
    http.get<{ wid: string; eid: string }>("/api/executions/:wid/stats/:eid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      if (privilegeOf(workflowResource(Number(params.wid)), user.uid) === "NONE") return errorResponse(401, "");
      const record = db.executionRecords.find(each => each.eid === Number(params.eid));
      if (!record || record.statistics.length === 0)
        return errorResponse(500, "There was an error processing your request.");
      return HttpResponse.json(record.statistics);
    }),

    // POST /executions/update_execution_name {wid, eId, executionName}, by someone who may change the workflow.
    http.post("/api/executions/update_execution_name", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { wid, eId, executionName } = (await request.json()) as { wid: number; eId: number; executionName: string };
      if (privilegeOf(workflowResource(wid), user.uid) !== "WRITE")
        return errorResponse(403, "No sufficient access privilege.");
      const record = db.executionRecords.find(each => each.eid === eId);
      if (record) record.name = executionName;
      return new HttpResponse(null, { status: 204 });
    }),

    // PUT /executions/set_execution_bookmarks {wid, eIds, isBookmarked}. isBookmarked is what the executions were:
    // true takes their bookmark away (WorkflowExecutionsResource.setExecutionAreBookmarked).
    http.put("/api/executions/set_execution_bookmarks", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { wid, eIds, isBookmarked } = (await request.json()) as {
        wid: number;
        eIds: number[];
        isBookmarked: boolean;
      };
      if (privilegeOf(workflowResource(wid), user.uid) !== "WRITE")
        return errorResponse(403, "No sufficient access privilege.");
      for (const record of db.executionRecords) if (eIds.includes(record.eid)) record.bookmarked = !isBookmarked;
      return new HttpResponse(null, { status: 204 });
    }),

    // PUT /executions/delete_executions {wid, eIds}, by someone who may change the workflow.
    http.put("/api/executions/delete_executions", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { wid, eIds } = (await request.json()) as { wid: number; eIds: number[] };
      if (privilegeOf(workflowResource(wid), user.uid) !== "WRITE")
        return errorResponse(403, "No sufficient access privilege.");
      db.executionRecords = db.executionRecords.filter(record => !eIds.includes(record.eid));
      return new HttpResponse(null, { status: 204 });
    }),

    engine.addEventListener("connection", ({ client }) => {
      const wid = Number(client.url.searchParams.get("wid"));
      const cuid = Number(client.url.searchParams.get("cuid"));
      const token = client.url.searchParams.get("access-token") ?? "";
      const user = signedInUser(db, new Request(client.url, { headers: { Authorization: `Bearer ${token}` } }));
      const connected = clients.get(wid) ?? new Set<Client>();
      clients.set(wid, connected.add(client));
      // Every connection starts with this; where a running execution stands follows it.
      client.send(JSON.stringify({ type: "WorkflowStateEvent", state: "Uninitialized" }));
      for (const event of db.executions[wid]?.standing ?? []) client.send(JSON.stringify(event));

      client.addEventListener("close", () => connected.delete(client));
      client.addEventListener("message", event => {
        const request = JSON.parse(event.data as string) as ExecutionRequest;
        const execution = db.executions[wid] as MockExecution | undefined;
        switch (request.type) {
          case "HeartBeatRequest":
            client.send(JSON.stringify({ type: "HeartBeatResponse" }));
            return;
          case "WorkflowExecuteRequest":
            if (!(user instanceof Response))
              void execute(wid, request.logicalPlan, request.warehouseId, user.uid, cuid);
            return;
          case "WorkflowPauseRequest":
            if (execution?.state === "Running") setState(wid, "Paused");
            return;
          case "WorkflowResumeRequest":
            if (execution?.state === "Paused") setState(wid, "Running");
            return;
          case "WorkflowKillRequest":
            if (execution) {
              setState(wid, "Killed");
              execution.finish();
            }
            return;
          case "ResultPaginationRequest": {
            const { requestID, operatorID, pageIndex, pageSize } = request;
            const table = execution?.outputs[operatorID] ?? { columns: [], rows: [] };
            const answer: ExecutionEvent = {
              type: "PaginatedResultEvent",
              requestID,
              operatorID,
              pageIndex,
              table: table.rows.slice((pageIndex - 1) * pageSize, pageIndex * pageSize),
              schema: table.columns,
            };
            // A page goes to whoever asked for it, not to everyone.
            client.send(JSON.stringify(answer));
          }
        }
      });
    }),
  ];
}
