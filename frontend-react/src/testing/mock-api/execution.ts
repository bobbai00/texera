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

// The computing units (ComputingUnitManagingResource.scala), the executions the Dashboard service creates and has
// a unit start (ExecutionResource.scala), and the engine's socket on a unit (WorkflowWebsocketResource.scala). As
// on the real engine, everyone connected to a workflow is sent the same events, whoever starts connecting later is
// told where the execution stands, and a new execution replaces the one before it. What an execution computes, and
// so what does not compile, comes from the stand-in engine in ./engine.ts.

import { ws } from "msw";
import { http, HttpResponse } from "msw/http";
import type {
  CreateExecutionFailure,
  CreateExecutionRequest,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionState,
  ExecutionStateAnswer,
} from "@/lib/execution/protocol";
import type { LogicalPlan } from "@/lib/workflow/plan";
import { admin } from "../fixtures";
import { errorResponse, type MockResource, privilegeOf } from "./access";
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

/** Adds a computing unit, running, owned by the admin and shared with no one unless told otherwise, and returns it. */
export function addComputingUnit(
  db: MockDb,
  seed: {
    name: string;
    status?: string;
    ownerUid?: number;
    grants?: MockResource["grants"];
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
    grants: seed.grants ?? [],
  });
  return unit;
}

/** A workflow's execution on the fake engine: the one slot that a real unit has for each workflow too. */
export interface MockExecution {
  /** The id of its record, which the unit names it by. */
  eid: number;
  state: ExecutionState;
  /** What every client is told again when it connects: the events that say where the execution stands. */
  standing: ExecutionEvent[];
  outputs: Record<string, MockTable | undefined>;
  /** Ends the wait of an execution that db.executionMs holds in "Running". */
  finish: () => void;
}

/**
 * What the backend keeps of an execution (workflow_executions), as it lists it. Its status is a code of
 * WorkflowExecutionStatus.scala: 6 created and started by no unit yet, 0 initializing, 1 running, 2 paused,
 * 3 completed, 4 failed, 5 killed, and -1 for a state that was not read.
 */
export interface MockExecutionRecord {
  eid: number;
  wid: number;
  /** The newest version of the workflow when the execution started. */
  vid: number;
  uid: number;
  cuid: number;
  /** While it is open, the newest state its log shows, which may be an ending; once it is closed, how it ended. */
  status: number;
  /**
   * Whether the service has closed it, recording how it ended (ExecutionRecords.close): the closing job does once its
   * log shows an ending or its unit is gone, and a start that never reached a unit does at once. Until then it is
   * open. A record that is added is closed when its status is an ending, unless told otherwise.
   */
  closed: boolean;
  /** Why it is in its status, when its closing record says: "replaced by execution 5", "compile error: …". */
  reason: string | null;
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
/** The status of an execution the service created and no unit has started. */
const createdStatus = 6;
/** The statuses of an execution that has ended, whose record the service has closed. */
const endedStatuses = new Set([3, 4, 5]);
/** The states of an execution on a unit that has ended: one that has ended keeps its state, whatever is asked. */
const endedStates = new Set<ExecutionState>(["Completed", "Failed", "Killed"]);

/**
 * Why the service refuses a start before it records anything, if it does (ExecutionCreator.checkedRequest): a part
 * of the request that is missing or wrong, as the Dashboard checks it, in its words.
 */
function requestProblem({
  wid,
  computingUnitId,
  executionName,
  engineVersion,
  logicalPlan,
  workflowSettings,
}: Partial<CreateExecutionRequest>): string | undefined {
  if (!(Number(wid) >= 1)) return "The request names no workflow.";
  if (!(Number(computingUnitId) >= 1)) return "The request names no computing unit to run the workflow on.";
  if ((executionName ?? "").length > 128) return "The execution's name is longer than 128 characters.";
  if (typeof engineVersion !== "string") return "The request names no engine version.";
  if (typeof logicalPlan !== "object" || logicalPlan === null || Array.isArray(logicalPlan))
    return "The request has no logical plan.";
  const batchSize = workflowSettings?.dataTransferBatchSize ?? 400;
  if (batchSize < 1) return `The workflow's Data Transfer Batch Size is ${batchSize}; set it to 1 or more.`;
  return undefined;
}

/**
 * Why the service refuses the warehouse a start names, if it does (ExecutionWarehouse.scala): a deployment with
 * warehouses requires one of the user's, and one without refuses any.
 */
function warehouseProblem(db: MockDb, warehouseId: number | undefined): string | undefined {
  if (!db.warehouses)
    return warehouseId === undefined ? undefined : "Per-user warehouses are disabled in this deployment.";
  if (warehouseId === undefined) return "A warehouse must be selected for this execution.";
  if (!db.warehouses.some(warehouse => warehouse.whid === warehouseId))
    return `You have no warehouse with id ${warehouseId}.`;
  return undefined;
}

/** The answer to a start whose workflow does not compile, with each operator's error. */
function notCompiled(eid: number, errors: Record<string, string>): CreateExecutionFailure {
  const ids = Object.keys(errors);
  // The compiler's words (WorkflowCompilationFailed.scala): a count, then a line for each operator.
  const count = ids.length === 1 ? "1 operator has an error." : `${ids.length} operators have errors.`;
  const at = Date.now();
  return {
    code: 400,
    message: [`The workflow does not compile: ${count}`, ...ids.map(id => `${id}: ${errors[id]}`)].join("\n"),
    eid,
    operatorErrors: Object.fromEntries(
      ids.map(id => [
        id,
        {
          type: { name: "COMPILATION_ERROR" },
          timestamp: { seconds: Math.floor(at / 1000), nanos: (at % 1000) * 1_000_000 },
          message: errors[id],
          details: "",
          operatorId: id,
          workerId: "",
        },
      ])
    ),
  };
}

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
    closed: endedStatuses.has(seed.status ?? 3),
    reason: null,
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
  const unitResource = (cuid: number): MockResource | undefined =>
    db.resources.find(resource => resource.type === "computing-unit" && resource.id === cuid);
  /** Whether a user may read a workflow, and so its executions (WorkflowAccess.hasReadAccess). */
  const mayRead = (wid: number, uid: number) => {
    const workflow = workflowResource(wid);
    return workflow.isPublic || privilegeOf(workflow, uid) !== "NONE";
  };
  // Who is connected to each workflow. Sockets are not records: they end with their test, not with a reset.
  const clients = new Map<number, Set<Client>>();

  function broadcast(wid: number, event: ExecutionEvent, standing = true) {
    if (standing) db.executions[wid]?.standing.push(event);
    for (const client of clients.get(wid) ?? []) client.send(JSON.stringify(event));
  }

  /** Writes into an execution's record that it is in `state`, for `reason` when one says why, as its log does. */
  function writeRecord(execution: MockExecution, state: ExecutionState, reason: string | null = null) {
    const kept = db.executionRecords.find(each => each.eid === execution.eid);
    if (kept && state in statusCodes)
      Object.assign(kept, { status: statusCodes[state], reason, lastUpdateTime: Date.now() });
  }

  function setState(wid: number, state: ExecutionState, reason: string | null = null) {
    const execution = db.executions[wid];
    execution.state = state;
    writeRecord(execution, state, reason);
    broadcast(wid, { type: "WorkflowStateEvent", state, executionId: execution.eid });
  }

  /** Executes a plan that compiled, as the unit it was handed to does, in place of the workflow's execution before. */
  async function execute(
    wid: number,
    plan: LogicalPlan,
    outputs: Record<string, MockTable | undefined>,
    record: MockExecutionRecord
  ) {
    const replaced = db.executions[wid] as MockExecution | undefined;
    if (replaced) {
      // One that has not ended is killed, which only its record says (WorkflowService.supersedeCurrentRun): the
      // sessions see the new execution take its place.
      if (!endedStates.has(replaced.state)) {
        replaced.state = "Killed";
        writeRecord(replaced, "Killed", `replaced by execution ${record.eid}`);
      }
      replaced.finish();
    }
    const execution: MockExecution = {
      eid: record.eid,
      state: "Initializing",
      standing: [],
      outputs,
      finish: () => {},
    };
    db.executions[wid] = execution;
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

    // POST /executions {wid, logicalPlan, computingUnitId, warehouseId?, ...} -> 201 {eid}: the service records the
    // execution, compiles its plan, and hands it to the unit, which starts it before the answer
    // (ExecutionCreator.create). Before any record, in this order: a request missing a part, or with settings no
    // plan can be made under, is a 400; a workflow the user may not read, or a unit they may not run workflows on,
    // a 403, and a unit that is terminated a 409; a warehouse they may not name, a 400. A workflow that does not
    // compile is a 400 too, and its execution is recorded as failed.
    http.post("/api/executions", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const asked = (await request.json()) as Partial<CreateExecutionRequest> | null;
      const problem = requestProblem(asked ?? {});
      if (problem) return errorResponse(400, problem);
      const { wid, logicalPlan, computingUnitId, warehouseId } = asked as CreateExecutionRequest;
      if (!mayRead(wid, user.uid)) return errorResponse(403, `You do not have access to workflow ${wid}.`);
      // A unit that does not exist is one the user may not run workflows on. A terminated one is still theirs.
      const unit = unitResource(computingUnitId);
      if (!unit || privilegeOf(unit, user.uid) !== "WRITE")
        return errorResponse(403, `You may not run workflows on computing unit ${computingUnitId}.`);
      if (!db.computingUnits.some(each => each.cuid === computingUnitId))
        return errorResponse(409, `Computing unit ${computingUnitId} is terminated.`);
      const refused = warehouseProblem(db, warehouseId);
      if (refused) return errorResponse(400, refused);
      // The backend records each execution with the newest version of the workflow when it is created.
      const record = addExecutionRecord(db, {
        wid,
        vid: db.workflows.find(workflow => workflow.wid === wid)?.saves.length ?? 1,
        uid: user.uid,
        cuid: computingUnitId,
        status: createdStatus,
        startingTime: Date.now(),
        lastUpdateTime: null,
      });
      const { outputs, errors } = evaluate(logicalPlan, db.files);
      if (Object.keys(errors).length > 0) {
        // Closed as failed with one operator's error, the first by id, as the same one is each time.
        const first = Object.keys(errors).sort()[0];
        Object.assign(record, {
          status: statusCodes.Failed,
          closed: true,
          reason: `compile error: ${errors[first]}`,
          lastUpdateTime: Date.now(),
        });
        return HttpResponse.json(notCompiled(record.eid, errors), { status: 400 });
      }
      void execute(wid, logicalPlan, outputs, record);
      return HttpResponse.json({ eid: record.eid }, { status: 201 });
    }),

    // GET /executions/{wid} -> the workflow's executions, newest first, to whoever may see it; nobody else is told
    // of any (WorkflowExecutionsResource.retrieveExecutionsOfWorkflow). Each has a time, never none: when it ended,
    // or while it is open, when it took its state or was created.
    http.get<{ wid: string }>("/api/executions/:wid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const wid = Number(params.wid);
      if (!mayRead(wid, user.uid)) return HttpResponse.json([]);
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
            reason: record.reason,
            startingTime: record.startingTime,
            completionTime: record.lastUpdateTime ?? record.startingTime,
            bookmarked: record.bookmarked,
            name: record.name,
            logLocation: null,
          }))
      );
    }),

    // GET /executions/{wid}/latest -> the workflow's latest execution, with the unit it was executed on. Someone who
    // may not read the workflow is answered 401 (validateUserCanAccessWorkflow), which signs the app out.
    http.get<{ wid: string }>("/api/executions/:wid/latest", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const wid = Number(params.wid);
      if (!mayRead(wid, user.uid)) return errorResponse(401, "HTTP 401 Unauthorized");
      const record = db.executionRecords.findLast(each => each.wid === wid);
      if (!record) return errorResponse(403, "Executions doesn't exist");
      return HttpResponse.json({ eId: record.eid, vId: record.vid, cuId: record.cuid, status: record.status });
    }),

    // GET /executions/{eid}/state -> where the service has the execution stand, whether or not its unit shows it
    // (ExecutionRecordReader.state), for whoever created it or owns or was granted its workflow; for anyone else,
    // and for an execution there is not, 403. One is open, whatever its log shows, until the service closes it.
    http.get<{ eid: string }>("/api/executions/:eid/state", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const record = db.executionRecords.find(each => each.eid === Number(params.eid));
      if (!record || (record.uid !== user.uid && privilegeOf(workflowResource(record.wid), user.uid) === "NONE"))
        return errorResponse(403, `You may not read execution ${params.eid}.`);
      const answer: ExecutionStateAnswer = {
        eid: record.eid,
        status: record.status,
        open: !record.closed,
        reason: record.reason,
        timeMs: record.lastUpdateTime ?? record.startingTime,
      };
      return HttpResponse.json(answer);
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
      const unit = unitResource(cuid);
      // What the gateway tells the unit its user may do on it (ServletAwareConfigurator).
      const access = user instanceof Response || !unit ? "NONE" : privilegeOf(unit, user.uid);
      if (access === "NONE") {
        // The gateway lets through no one whose token it cannot read or who may not use the unit
        // (AccessControlResource.checkComputingUnitAccess), and the unit closes a socket that comes without its
        // word (WorkflowWebsocketResource.myOnOpen): the socket closes before it opens, and is told nothing.
        client.close(1008, "A computing unit is reached through the gateway.");
        return;
      }
      const connected = clients.get(wid) ?? new Set<Client>();
      clients.set(wid, connected.add(client));
      // Every connection starts with the state of no execution; where a running execution stands follows it.
      client.send(JSON.stringify({ type: "WorkflowStateEvent", state: "Uninitialized" }));
      for (const event of db.executions[wid]?.standing ?? []) client.send(JSON.stringify(event));
      // A refusal goes to whoever asked, and to no one else: the execution is as it was.
      const refuse = (message: string, request?: string, executionId?: number) => {
        const refusal: ExecutionEvent = { type: "RequestRefusedEvent", request, executionId, message };
        client.send(JSON.stringify(refusal));
      };

      client.addEventListener("close", () => connected.delete(client));
      client.addEventListener("message", event => {
        let frame: { type?: unknown } | null;
        try {
          frame = JSON.parse(event.data as string) as { type?: unknown } | null;
        } catch {
          frame = null;
        }
        const request = (frame ?? {}) as ExecutionRequest;
        const execution = db.executions[wid] as MockExecution | undefined;
        switch (request.type) {
          case "HeartBeatRequest":
            client.send(JSON.stringify({ type: "HeartBeatResponse" }));
            return;
          case "WorkflowPauseRequest":
          case "WorkflowResumeRequest":
          case "WorkflowKillRequest": {
            // A command is its sender's to make only with WRITE on the unit, and is for the execution it names,
            // which must be the one the unit holds. One that has ended stays as it ended, whatever is asked.
            const { type, executionId } = request;
            if (access !== "WRITE") {
              refuse("You do not have write access to the computing unit.", type, executionId);
            } else if (execution?.eid !== executionId) {
              refuse(`Execution ${executionId} is not running here.`, type, executionId);
            } else if (endedStates.has(execution.state)) {
              return;
            } else if (type === "WorkflowKillRequest") {
              setState(wid, "Killed", "killed by the user");
              execution.finish();
            } else if (type === "WorkflowPauseRequest" && execution.state === "Running") {
              setState(wid, "Paused");
            } else if (type === "WorkflowResumeRequest" && execution.state === "Paused") {
              setState(wid, "Running");
            }
            return;
          }
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
            return;
          }
          default: {
            // A frame that reads as no request the unit takes, such as a start, which only the service makes. It is
            // named by the type it gives only when that reads as the name of a type (typeNamedBy).
            const kind =
              typeof frame?.type === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(frame.type)
                ? frame.type
                : undefined;
            refuse(kind ? `The request could not be read as a ${kind}.` : "The request could not be read.", kind);
          }
        }
      });
    }),
  ];
}
