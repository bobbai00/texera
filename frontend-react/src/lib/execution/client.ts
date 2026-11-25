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

// The app's end of the executions of a workflow on a computing unit. An execution is started by asking the
// Dashboard service to create it, and followed over one connection to the engine's socket on the unit. The engine
// sends everyone connected to the same workflow the same events, and tells whoever connects in the middle of an
// execution where it stands, so the execution a client shows may be one that someone else started. While the unit
// does not show the execution that is followed, because its socket is down or because it holds no execution, the
// Dashboard service is asked where that one stands. The client keeps what the events and the answers add up to, the
// snapshot, and tells its listeners when it changes.

import { api, ApiError } from "@/lib/api-client";
import { getSession } from "@/lib/session";
import type { Attribute } from "@/lib/workflow/compilation";
import type { WorkflowSettings } from "@/lib/workflow/model";
import type { LogicalPlan } from "@/lib/workflow/plan";
import type {
  CreateExecutionRequest,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionState,
  ExecutionStateAnswer,
  FatalError,
} from "./protocol";

/** What an operator is doing in the execution. */
export interface OperatorProgress {
  state: string;
  inputRows: number;
  outputRows: number;
}

/** What an operator has put out: rows to page through, or a visualization as a page of HTML. */
export type OperatorResult =
  { kind: "table"; totalRows: number; revision: number } | { kind: "visualization"; html: string; revision: number };

/** Why an execution failed or did not start. */
export interface ExecutionError {
  message: string;
  details?: string;
  /** The operator the error is about, when it is about one. */
  operatorId?: string;
}

export interface ConsoleMessage {
  /** The engine's kind of line, such as "PRINT" or "ERROR". */
  kind: string;
  title: string;
  message: string;
}

/** Everything the app knows of the workflow's latest execution on this computing unit. */
export interface ExecutionSnapshot {
  /** Whether the socket is open. Nothing can be started while it is not, and what is asked meanwhile waits for it. */
  connected: boolean;
  state: ExecutionState;
  /**
   * The execution shown, which a pause, a resume and a stop name: the one the unit names, or else the one the
   * service created for the last start. None from the moment a start is asked for until one of the two names it,
   * and none while the unit shows no execution.
   */
  executionId?: number;
  /**
   * Whether the state shown is the Dashboard service's word for the execution, because its unit does not show it:
   * the unit cannot be asked to pause, resume or stop it, and, once connected, may be asked to start another.
   */
  followedAtDashboard: boolean;
  operators: Record<string, OperatorProgress>;
  results: Record<string, OperatorResult>;
  errors: ExecutionError[];
  console: Record<string, ConsoleMessage[]>;
  /**
   * Why something that was asked was not done, in words for the user, such as a stop the unit refused. It says
   * nothing of the execution, which is as it was, and it goes once something else is asked or the state changes.
   */
  notice?: string;
}

/** One page of an operator's result. */
export interface ResultPage {
  rows: Record<string, unknown>[];
  columns: Attribute[];
}

/** The states in which an execution is under way, so that another cannot be started. */
export const activeStates: ReadonlySet<ExecutionState> = new Set([
  "Initializing",
  "Running",
  "Pausing",
  "Paused",
  "Resuming",
  "Recovering",
]);

const heartbeatMs = 10_000;
const reconnectMs = 3_000;
/**
 * How long the unit has not shown the execution that is followed before the Dashboard service is asked where it
 * stands, and then how often it is asked again: the unit of a socket that only dropped names it again first.
 */
export const dashboardFollowMs = 5_000;
/** The lines kept for each operator. The engine itself keeps the last hundred. */
const consoleLines = 200;

/** The requests that ask something of an execution: one asked while the socket is down is sent once it is up. */
const commands = new Set<ExecutionRequest["type"]>([
  "WorkflowPauseRequest",
  "WorkflowResumeRequest",
  "WorkflowKillRequest",
]);

const disconnected: ExecutionSnapshot = {
  connected: false,
  state: "Uninitialized",
  followedAtDashboard: false,
  operators: {},
  results: {},
  errors: [],
  console: {},
};

export class ExecutionClient {
  private socket: WebSocket | undefined;
  private current = disconnected;
  private closed = false;
  /**
   * The execution that is followed: the one the unit named last, or the one the service created for the last start.
   * Unlike the snapshot's, it outlives a unit that stops showing it, so that the service can be asked how it went.
   * None from a start until either names one, and none once the service says it has ended.
   */
  private followed: number | undefined;
  /** The questions to the service about the followed execution, while its unit does not show it. */
  private dashboardPoll: ReturnType<typeof setInterval> | undefined;
  /** The last start, counted, while the service has not answered it: an answer to an earlier one is not taken. */
  private pendingStart: number | undefined;
  private starts = 0;
  /** Whether a stop was asked for while the execution being created had no id yet. It is sent once it has one. */
  private killOnceCreated = false;
  /** What was asked of an execution while the socket was not open, to send once it is. */
  private unsent: ExecutionRequest[] = [];
  /**
   * What the socket was told since the state of no execution, until it names an execution: the operators whose
   * results and whose lines it was told, and whether it was told their progress. A unit tells a new socket the
   * state of no execution, then all it holds of the execution it holds, then that one's state, which names it: what
   * the socket was not told by then is of no execution the unit holds. None once the socket has named one.
   */
  private replay: { results: Set<string>; console: Set<string>; operators: boolean } | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<string, { resolve: (page: ResultPage) => void; reject: (error: Error) => void }>();
  private readonly workflowId: number;
  private readonly computingUnitId: number;

  constructor(workflowId: number, computingUnitId: number) {
    this.workflowId = workflowId;
    this.computingUnitId = computingUnitId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ExecutionSnapshot => this.current;

  /** Opens the socket, and opens it again whenever it closes, until close() is called. */
  connect(): void {
    this.closed = false;
    const session = getSession();
    const url = new URL("/wsapi/workflow-websocket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({
      wid: String(this.workflowId),
      uid: String(session?.userId ?? ""),
      cuid: String(this.computingUnitId),
      "access-token": session?.token ?? "",
    }).toString();
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.heartbeat = setInterval(() => this.send({ type: "HeartBeatRequest" }), heartbeatMs);
      // What was asked while the socket was down is asked now.
      for (const request of this.unsent.splice(0)) socket.send(JSON.stringify(request));
    };
    socket.onmessage = event => this.receive(JSON.parse(String(event.data)) as ExecutionEvent);
    socket.onclose = () => {
      // A socket that another has replaced says nothing of the connection.
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      for (const page of this.pages.values()) page.reject(new Error("The connection to the computing unit was lost."));
      this.pages.clear();
      this.update({ connected: false });
      if (this.closed) return;
      // A unit whose socket is down shows no execution: the service is asked about the one that is followed.
      this.followAtDashboard();
      this.reconnect = setTimeout(() => this.connect(), reconnectMs);
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    // A start the service has not answered, and the execution followed, are followed no more: an answer that comes
    // after is not taken, and the service is asked about neither.
    this.pendingStart = undefined;
    this.killOnceCreated = false;
    this.unfollow();
    this.unsent = [];
    this.socket?.close();
  }

  /**
   * Starts an execution of the plan: the Dashboard service creates it, and has this unit start it. It replaces the
   * workflow's execution on this unit, whoever started that one. Where the deployment has warehouses, the
   * execution keeps its results in the one that is named. An execution up to an operator is given the part of the
   * workflow that it needs, as `logicalPlan(content, operatorId)` makes it.
   *
   * @returns once the service has answered, whatever it answered: it never fails, and what became of the start is
   *          in the snapshot
   */
  start(plan: LogicalPlan, settings: WorkflowSettings, warehouseId?: number): Promise<void> {
    const start = ++this.starts;
    this.pendingStart = start;
    this.killOnceCreated = false;
    // The execution asked for is the one shown, in place of the one followed: it has no id until one is named.
    this.unfollow();
    this.update({
      state: "Initializing",
      executionId: undefined,
      operators: {},
      results: {},
      errors: [],
      console: {},
      notice: undefined,
    });
    const request: CreateExecutionRequest = {
      wid: this.workflowId,
      executionName: "",
      engineVersion: "",
      logicalPlan: plan,
      workflowSettings: settings,
      emailNotificationEnabled: false,
      computingUnitId: this.computingUnitId,
      // What is not asked for is left out: the service refuses a warehouse where there are none.
      ...(warehouseId === undefined ? {} : { warehouseId }),
    };
    return api<unknown>("/executions", { method: "POST", json: request }).then(
      answer => this.created(start, executionIdIn(answer)),
      (error: unknown) =>
        // A success whose body could not be read created the execution all the same.
        error instanceof ApiError && error.status >= 200 && error.status < 300
          ? this.created(start, undefined)
          : this.notCreated(start, error, plan)
    );
  }

  pause(): void {
    const { executionId } = this.current;
    if (executionId !== undefined) this.command({ type: "WorkflowPauseRequest", executionId });
  }

  resume(): void {
    const { executionId } = this.current;
    if (executionId !== undefined) this.command({ type: "WorkflowResumeRequest", executionId });
  }

  /**
   * Stops an execution for good: the one named, or else the one the client shows. A stop asked for while that one
   * is being created, before anything names it, is sent once the service says which it is.
   */
  kill(executionId = this.current.executionId): void {
    if (executionId !== undefined) this.command({ type: "WorkflowKillRequest", executionId });
    else if (this.pendingStart !== undefined) this.killOnceCreated = true;
  }

  /** One page of an operator's result rows. The first page is page 1. */
  page(operatorId: string, pageIndex: number, pageSize: number): Promise<ResultPage> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the computing unit."));
        return;
      }
      const requestID = crypto.randomUUID();
      this.pages.set(requestID, { resolve, reject });
      this.send({ type: "ResultPaginationRequest", requestID, operatorID: operatorId, pageIndex, pageSize });
    });
  }

  /** The service's answer to the start counted `start`: it created execution `eid`, or one it did not name. */
  private created(start: number, eid: number | undefined): void {
    if (this.pendingStart !== start) return;
    this.pendingStart = undefined;
    const killAsked = this.killOnceCreated;
    this.killOnceCreated = false;
    if (eid === undefined) {
      if (killAsked) {
        this.update({
          notice:
            "The execution was created, but the Dashboard service did not say which it is, so it was not stopped.",
        });
      }
      return;
    }
    // The unit starts the execution before the service answers, so it may have named it already, or named one
    // that someone else started since: its word stands. Otherwise the service's word is taken for the one shown,
    // and, while the socket is down, the service is asked where it stands.
    if (this.current.executionId === undefined) {
      this.follow(eid);
      this.update({ executionId: eid });
      if (!this.current.connected) this.followAtDashboard();
    }
    if (killAsked) this.send({ type: "WorkflowKillRequest", executionId: eid });
  }

  /** The service's answer to the start counted `start`: it did not start an execution, for the reason `error` gives. */
  private notCreated(start: number, error: unknown, plan: LogicalPlan): void {
    if (this.pendingStart !== start) return;
    this.pendingStart = undefined;
    this.killOnceCreated = false;
    // The unit has named an execution since the start, maybe the very one the service could not say it started:
    // the unit's word stands, and what the service said is a notice.
    if (this.current.executionId !== undefined) {
      this.update({ notice: failureMessage(error) });
      return;
    }
    this.update({ state: "Failed", errors: operatorErrorsOf(error, plan) ?? [{ message: failureMessage(error) }] });
  }

  /** Asks something of an execution: what was not done before is not told any more. */
  private command(request: ExecutionRequest): void {
    if (this.current.notice !== undefined) this.update({ notice: undefined });
    this.send(request);
  }

  private send(request: ExecutionRequest): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(request));
    else if (commands.has(request.type)) this.unsent.push(request);
  }

  private update(change: Partial<ExecutionSnapshot>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Follows execution `eid`, which its unit shows: the service is not asked about it. */
  private follow(eid: number): void {
    this.followed = eid;
    this.stopAsking();
  }

  private unfollow(): void {
    this.followed = undefined;
    this.stopAsking();
  }

  /**
   * Asks the Dashboard service where the followed execution stands from now on, as its unit has stopped showing it:
   * every `dashboardFollowMs`, the first time that long from now. Does nothing for an execution that is not under
   * way, or while the service is asked already. A question that fails is asked again at the next turn, and none is
   * asked while the one before it is unanswered.
   */
  private followAtDashboard(): void {
    const eid = this.followed;
    if (eid === undefined || !activeStates.has(this.current.state) || this.dashboardPoll !== undefined) return;
    let asking = false;
    this.dashboardPoll = setInterval(() => {
      if (asking) return;
      asking = true;
      void api<unknown>(`/executions/${eid}/state`)
        .then(
          answer => this.answered(eid, answer),
          () => {}
        )
        .finally(() => (asking = false));
    }, dashboardFollowMs);
    this.update({ followedAtDashboard: true });
  }

  private stopAsking(): void {
    if (this.dashboardPoll === undefined) return;
    clearInterval(this.dashboardPoll);
    this.dashboardPoll = undefined;
    this.update({ followedAtDashboard: false });
  }

  /**
   * Shows where the service says execution `eid` stands. One that it has closed is not asked about again; an answer
   * that cannot be read says nothing, and the service is asked again.
   */
  private answered(eid: number, answer: unknown): void {
    if (this.followed !== eid || this.dashboardPoll === undefined || !isStateAnswer(answer)) return;
    if (!answer.open) this.unfollow();
    const shown = answeredState(answer);
    if (shown) this.show(shown.state, shown.errors);
  }

  /** Shows the execution in `state`: what was not done before goes when the state changes. */
  private show(state: ExecutionState, errors: ExecutionError[], change: Partial<ExecutionSnapshot> = {}): void {
    this.update({
      ...change,
      state,
      errors,
      notice: state === this.current.state ? this.current.notice : undefined,
      operators: operatorsAt(state, change.operators ?? this.current.operators),
    });
  }

  private receive(event: ExecutionEvent): void {
    switch (event.type) {
      case "WorkflowStateEvent": {
        const { state, executionId } = event;
        if (typeof executionId !== "number") {
          // The state of no execution: what every new socket is told first, and all that a unit holding none says.
          // It is not the end of a start the service has not answered, or of the followed execution while that is
          // under way: they stay as they are, and the service is asked about the one followed until the unit names
          // it again. What the socket is told next, until it names an execution, is all its unit holds of that one.
          this.replay = { results: new Set(), console: new Set(), operators: false };
          if (
            this.pendingStart !== undefined ||
            (this.followed !== undefined && activeStates.has(this.current.state))
          ) {
            this.update({ connected: true, executionId: undefined });
            this.followAtDashboard();
          } else {
            this.show(state, this.current.errors, { connected: true, executionId: undefined });
          }
          return;
        }
        // The unit names the execution of each state it tells: the one this client started, or someone else's. Its
        // word is the state shown, and an execution in any state but Failed, whose errors follow it, has not failed.
        // Nothing of another execution than the one followed is shown, as at a start: a new socket was just told all
        // that its unit holds of the one it names, and a socket that is open is told of a new one from its start.
        const another = executionId !== this.followed;
        const change: Partial<ExecutionSnapshot> = { connected: true, executionId };
        if (this.replay) {
          change.results = ofOperators(this.current.results, this.replay.results);
          change.console = ofOperators(this.current.console, this.replay.console);
          if (!this.replay.operators) change.operators = {};
          this.replay = undefined;
        } else if (another) {
          Object.assign(change, { results: {}, console: {}, operators: {} });
        }
        this.follow(executionId);
        this.show(state, state === "Failed" && !another ? this.current.errors : [], change);
        return;
      }
      case "RequestRefusedEvent": {
        // A request of this client's that the unit did not do. The execution is as it was.
        if (event.request === "ResultPaginationRequest") {
          // A page that could not be read fails with why. The refusal names no page, but the unit answers a socket's
          // requests in the order they came: it is the first of the pages that wait for an answer.
          const requestID = this.pages.keys().next().value;
          if (requestID !== undefined) {
            this.pages.get(requestID)?.reject(new Error(event.message));
            this.pages.delete(requestID);
          }
          return;
        }
        // Something asked of the execution: the user is told why it was not done.
        this.update({ notice: event.message });
        return;
      }
      case "OperatorStatisticsUpdateEvent":
        if (this.replay) this.replay.operators = true;
        this.update({
          operators: operatorsAt(
            this.current.state,
            Object.fromEntries(
              Object.entries(event.operatorStatistics).map(([id, statistics]) => [
                id,
                {
                  state: statistics.operatorState,
                  inputRows: statistics.aggregatedInputRowCount,
                  outputRows: statistics.aggregatedOutputRowCount,
                },
              ])
            )
          ),
        });
        return;
      case "WebResultUpdateEvent": {
        const results = { ...this.current.results };
        for (const [id, { mode, totalNumTuples, table }] of Object.entries(event.updates)) {
          const revision = (results[id]?.revision ?? 0) + 1;
          // A snapshot's last row is the whole of it: a visualization, as a page of HTML.
          const html = table?.at(-1)?.["html-content"];
          if (mode.type === "PaginationMode") results[id] = { kind: "table", totalRows: totalNumTuples ?? 0, revision };
          else if (mode.type === "SetSnapshotMode" && typeof html === "string")
            results[id] = { kind: "visualization", html, revision };
          else continue;
          this.replay?.results.add(id);
        }
        this.update({ results });
        return;
      }
      case "WorkflowErrorEvent": {
        const errors = event.fatalErrors.map(({ message, details, operatorId }) => ({
          message,
          details: details || undefined,
          operatorId: operatorId && operatorId !== "unknown operator" ? operatorId : undefined,
        }));
        // The engine says "Failed" only through its errors.
        this.update({ errors, state: errors.length > 0 ? "Failed" : this.current.state });
        return;
      }
      case "ConsoleUpdateEvent": {
        const lines = event.messages.map(({ msgType, title, message }) => ({ kind: msgType.name, title, message }));
        // A new socket is told all the lines its unit keeps of an operator, in place of those shown, and then each
        // new line, as a socket that is open is.
        const told = this.replay?.console;
        const before = told && !told.has(event.operatorId) ? [] : (this.current.console[event.operatorId] ?? []);
        told?.add(event.operatorId);
        const kept = [...before, ...lines].slice(-consoleLines);
        this.update({ console: { ...this.current.console, [event.operatorId]: kept } });
        return;
      }
      case "PaginatedResultEvent": {
        this.pages.get(event.requestID)?.resolve({ rows: event.table, columns: event.schema });
        this.pages.delete(event.requestID);
        return;
      }
      default:
        if (!this.current.connected) this.update({ connected: true });
    }
  }
}

/** What `byOperator` holds of the operators `ids` names. */
function ofOperators<T>(byOperator: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(byOperator).filter(([id]) => ids.has(id)));
}

/** The id of the execution that the service says it created, if its answer names one. */
function executionIdIn(answer: unknown): number | undefined {
  const eid = (answer as { eid?: unknown } | null | undefined)?.eid;
  return typeof eid === "number" ? eid : undefined;
}

/** The Dashboard service's own answer to a request it did not serve, {code, message}, if the error is one. */
function serviceAnswerOf(error: unknown): { message: string; operatorErrors?: unknown } | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const answer = error.body as { code?: unknown; message?: unknown; operatorErrors?: unknown } | null | undefined;
  return typeof answer?.code === "number" && typeof answer.message === "string"
    ? { message: answer.message, operatorErrors: answer.operatorErrors }
    : undefined;
}

/**
 * The operators' errors of a start that failed because the workflow does not compile, each on its operator: the
 * plan's operators each after those it reads from, so that the cause of a chain of errors comes first, then any
 * other in the order of its id, as the service keys them in no order. Undefined for any other failure.
 */
function operatorErrorsOf(error: unknown, plan: LogicalPlan): ExecutionError[] | undefined {
  const operatorErrors = serviceAnswerOf(error)?.operatorErrors;
  if (typeof operatorErrors !== "object" || operatorErrors === null || Array.isArray(operatorErrors)) return undefined;
  const byOperator = operatorErrors as Record<string, Partial<FatalError> | null>;
  const ids = Object.keys(byOperator).filter(id => typeof byOperator[id]?.message === "string");
  if (ids.length === 0) return undefined;
  const inPlan = upstreamFirst(plan).filter(id => ids.includes(id));
  const others = ids.filter(id => !inPlan.includes(id)).sort();
  return [...inPlan, ...others].map(operatorId => {
    const { message, details } = byOperator[operatorId] as FatalError;
    return { message, details: details || undefined, operatorId };
  });
}

/**
 * Why a start failed, in words for the user, as the Angular app words it: the reason the Dashboard service gives,
 * such as a unit that is terminated or would not start the execution (409), that cannot be reached (503), or that
 * did not say whether it started it (504); or, for an answer that is not the service's own, what became of it. That
 * one names the status without its reason phrase, which an answer over HTTP/2 does not carry.
 */
function failureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  const answer = serviceAnswerOf(error);
  if (answer?.message) return answer.message;
  if (error.status === 0) return "The Dashboard service could not be reached.";
  if (error.status === 413) return "The workflow is larger than this deployment accepts in one request.";
  return `The Dashboard service answered ${error.status}.`;
}

/** The ids of a plan's operators, each after the operators it reads from, and otherwise in the plan's order. */
function upstreamFirst(plan: LogicalPlan): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const place = (id: string) => {
    if (ordered.includes(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const link of plan.links) if (link.toOpId === id) place(link.fromOpId);
    visiting.delete(id);
    ordered.push(id);
  };
  for (const operator of plan.operators) place(operator.operatorID as string);
  return ordered;
}

/** Whether an answer of the service is where it has an execution stand: a status, and whether it is open. */
function isStateAnswer(answer: unknown): answer is ExecutionStateAnswer {
  const { status, open } = (answer ?? {}) as { status?: unknown; open?: unknown };
  return typeof status === "number" && typeof open === "boolean";
}

/** The states of the codes of the service that say an execution is under way. */
const underWayStates: Record<number, ExecutionState> = { 0: "Initializing", 1: "Running", 2: "Paused" };

/**
 * The state that the service's answer gives an execution, read as its history reads the same status, and why it
 * failed, when it says. Undefined for an answer that says nothing of where it stands, while it is open: created and
 * started by no unit yet, or a state that could not be read.
 */
function answeredState({
  status,
  open,
  reason,
}: ExecutionStateAnswer): { state: ExecutionState; errors: ExecutionError[] } | undefined {
  if (status === 3) return { state: "Completed", errors: [] };
  if (status === 5) return { state: "Killed", errors: [] };
  // A closed execution has ended, whatever the answer calls the way it ended.
  if (status === 4 || !open) return { state: "Failed", errors: reason ? [{ message: reason }] : [] };
  const state = underWayStates[status] as ExecutionState | undefined;
  return state && { state, errors: [] };
}

/**
 * The operators as they stand for an execution in a state. Once an execution has completed, so has each of its
 * operators: the engine's last word on an operator can be older than its last word on the execution.
 */
function operatorsAt(
  state: ExecutionState,
  operators: Record<string, OperatorProgress>
): Record<string, OperatorProgress> {
  if (state !== "Completed") return operators;
  return Object.fromEntries(Object.entries(operators).map(([id, progress]) => [id, { ...progress, state }]));
}
