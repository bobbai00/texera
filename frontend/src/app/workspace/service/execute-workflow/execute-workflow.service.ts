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

import { Inject, Injectable, DOCUMENT } from "@angular/core";
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  EMPTY,
  exhaustMap,
  interval,
  Observable,
  Subject,
  Subscription,
  switchMap,
  tap,
  timer,
} from "rxjs";
import { WorkflowActionService } from "../workflow-graph/model/workflow-action.service";
import { WorkflowGraphReadonly } from "../workflow-graph/model/workflow-graph";
import {
  ExecutionState,
  ExecutionStateInfo,
  LogicalLink,
  LogicalOperator,
  LogicalPlan,
} from "../../types/execute-workflow.interface";
import { WorkflowWebsocketService } from "../workflow-websocket/workflow-websocket.service";
import {
  OperatorCurrentTuples,
  RegionStateEvent,
  RegionUpdateEvent,
  RequestRefusedEvent,
  TexeraWebsocketEvent,
  WorkflowFatalError,
} from "../../types/workflow-websocket.interface";
import { isEqual } from "lodash-es";
import { Version as version } from "src/environments/version";
import { NotificationService } from "src/app/common/service/notification/notification.service";
import { exhaustiveGuard } from "../../../common/util/switch";
import { WorkflowStatusService } from "../workflow-status/workflow-status.service";
import { intersection } from "../../../common/util/set";

import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { unavailableComputingUnitReason } from "../../../common/util/computing-unit.util";
import { WarehouseService } from "../../../common/service/warehouse/warehouse.service";
import { GuiConfigService } from "../../../common/service/gui-config.service";
import {
  CreateExecutionRequest,
  ExecutionApiService,
  ExecutionStateResponse,
  failureMessage,
  operatorErrorsOf,
  ReplayExecutionInfo,
} from "./execution-api.service";
import { EXECUTION_STATUS_CODE } from "../../../dashboard/type/workflow-executions-entry";

// TODO: change this declaration
export const FORM_DEBOUNCE_TIME_MS = 150;

/**
 * How long the computing unit has not shown the run on screen before the Dashboard service is asked for the
 * run's state, and how long after each question the next one is asked.
 */
export const FOLLOWED_EXECUTION_POLL_INTERVAL_MS = 5000;

/** Why a run failed at `timeMs`, as an error of the run that belongs to no operator. */
function runFailure(message: string, timeMs: number): WorkflowFatalError {
  return {
    type: { name: "EXECUTION_FAILURE" },
    timestamp: { seconds: Math.floor(timeMs / 1000), nanos: (timeMs % 1000) * 1_000_000 },
    message,
    details: "",
    operatorId: "",
    workerId: "",
  };
}

/** Why a run did not start, as an error of the run that belongs to no operator. */
function startFailure(message: string): WorkflowFatalError {
  return runFailure(message, Date.now());
}

/** A run that failed, as the Dashboard service's `answer` for its execution says why, if it says why. */
function failedAsAnswered(answer: ExecutionStateResponse): ExecutionStateInfo {
  return {
    state: ExecutionState.Failed,
    errorMessages: answer.reason ? [runFailure(answer.reason, answer.timeMs)] : [],
  };
}

/**
 * The state of a run as `answer`, the Dashboard service's answer for its execution, gives it, read the way the
 * execution history reads the same status; `shown` is the state on screen. Undefined for an answer that says
 * nothing of a run: the execution is created and no unit has started it, or its stored state could not be read.
 */
function stateAnsweredFor(answer: ExecutionStateResponse, shown: ExecutionStateInfo): ExecutionStateInfo | undefined {
  const status = EXECUTION_STATUS_CODE[answer.status];
  if (status === ExecutionState.Completed) {
    return { state: ExecutionState.Completed };
  }
  if (status === ExecutionState.Killed) {
    return { state: ExecutionState.Killed };
  }
  // A closed execution has ended, whatever the answer calls the way it ended.
  if (status === ExecutionState.Failed || !answer.open) {
    return failedAsAnswered(answer);
  }
  switch (status) {
    case ExecutionState.Initializing:
      return { state: ExecutionState.Initializing };
    case ExecutionState.Running:
      return { state: ExecutionState.Running };
    case ExecutionState.Paused:
      // The tuples a paused run stopped at are its unit's to tell: the ones on screen stay.
      return shown.state === ExecutionState.Paused ? shown : { state: ExecutionState.Paused, currentTuples: {} };
    default:
      return undefined;
  }
}

/**
 * The errors of a run of `plan` whose execution the Dashboard service did not create, `error` being how the
 * request for it failed: the operators' errors when the workflow does not compile ({@link operatorErrorsOf}),
 * or else the failure's reason, as one error that belongs to no operator.
 */
function errorsOfFailedCreate(error: unknown, plan: LogicalPlan): ReadonlyArray<WorkflowFatalError> {
  const operatorErrors = operatorErrorsOf(error, plan);
  if (operatorErrors !== undefined) {
    return operatorErrors;
  }
  return [startFailure(failureMessage(error))];
}

/**
 * ExecuteWorkflowService sends the current workflow data to the backend
 *  for execution, then receives backend's response and broadcast it to other components.
 *
 * ExecuteWorkflowService transforms the frontend workflow graph
 *  into backend API compatible workflow graph before sending the request.
 *
 * Components should call executeWorkflow() function to execute the current workflow
 *
 * Components and Services should subscribe to getExecuteStartedStream()
 *  in order to capture the event of workflow graph starts executing.
 *
 * Components and Services subscribe to getExecuteEndedStream()
 *  for the event of the execution result (or errro) returned by the backend.
 *
 * @author Zuozhi Wang
 * @author Henry Chen
 */
@Injectable({
  providedIn: "root",
})
export class ExecuteWorkflowService {
  private currentState: ExecutionStateInfo = {
    state: ExecutionState.Uninitialized,
  };
  private executionStateStream = new Subject<{
    previous: ExecutionStateInfo;
    current: ExecutionStateInfo;
  }>();

  private regionUpdateStream = new Subject<RegionUpdateEvent>();
  private regionStateStream = new Subject<RegionStateEvent>();

  // TODO: move this to another service, or redesign how this
  //   information is stored on the frontend.
  private assignedWorkerIds: Map<string, readonly string[]> = new Map();
  /**
   * The clock for the current run, as an anchor rather than a snapshot: the backend sends
   * `ExecutionDurationUpdateEvent` exactly twice per run -- once just after `startTimeStamp` is
   * written, carrying a few milliseconds, and once when `endTimeStamp` is -- so the reported number
   * stands still for the whole run and only the local tick advances it. Anchored, any view can work
   * out how long the run has been going whenever it mounts.
   */
  private durationAnchor: { reported: number; at: number; isRunning: boolean } = {
    reported: 0,
    at: 0,
    isRunning: false,
  };
  /** Ticks while a run is going; replays the current value to a view that mounts mid-run. */
  private readonly executionDuration = new BehaviorSubject<number>(0);
  private durationTicker?: Subscription;

  /**
   * The run that was asked for and has not reached the computing unit yet: its wait for the form debounce,
   * then the creation of its execution at the Dashboard service. Closed once the execution is created or
   * refused, and when the run is given up before that.
   */
  private pendingRun = Subscription.EMPTY;
  /**
   * The execution of the run on screen: the one this page asked the computing unit to start, once the
   * Dashboard service has created it, and then the one the unit names with each state it reports. A pause, a
   * resume, a kill and a change to a paused operator name it, whichever page started the run.
   */
  private currentExecutionId?: number;
  /**
   * The execution this page asked the computing unit to start, until the unit answers: with the state of a
   * run, which is the run on screen from then on, or by refusing the start.
   */
  private awaitedStart?: number;
  /**
   * The execution this page follows: the one it asked the computing unit to start, or the one the unit named
   * last. Unlike {@link currentExecutionId} it outlives a unit that stops showing its run, so that the
   * Dashboard service can be asked how the run went. Forgotten once the Dashboard service says the
   * execution is closed, when another run is asked for, and when the page leaves the session.
   */
  private followedExecutionId?: number;
  /**
   * The workflow the followed execution ran, as the editor held it when an operator of the paused run was first
   * unlocked for a logic change, before any edit: the Dashboard service compiles each change to the run's operators
   * against it. Forgotten once the run leaves Paused, and when another execution is followed or started.
   */
  private workflowSnapshot?: LogicalPlan;
  /**
   * The questions to the Dashboard service about the followed execution: asked while the run on screen is in
   * flight and its unit does not show it, because the socket is down or because the unit, on a socket that is
   * up, says that it holds no run. Closed while the unit shows the run, and once the execution is closed.
   */
  private dashboardPoll = Subscription.EMPTY;
  /** Whether {@link dashboardPoll} is open, for the views that offer to pause, resume, kill and run. */
  private readonly followingAtDashboard = new BehaviorSubject<boolean>(false);
  /** Whether the socket to the computing unit is up, as the websocket service said last. */
  private socketConnected = false;

  constructor(
    private workflowActionService: WorkflowActionService,
    private workflowWebsocketService: WorkflowWebsocketService,
    private workflowStatusService: WorkflowStatusService,
    private notificationService: NotificationService,
    @Inject(DOCUMENT) private document: Document,
    private computingUnitStatusService: ComputingUnitStatusService,
    private warehouseService: WarehouseService,
    private config: GuiConfigService,
    private executionApiService: ExecutionApiService
  ) {
    workflowWebsocketService.websocketEvent().subscribe(event => {
      switch (event.type) {
        case "RegionUpdateEvent":
          this.regionUpdateStream.next(event);
          break;
        case "RegionStateEvent":
          this.regionStateStream.next(event);
          break;
        case "WorkerAssignmentUpdateEvent":
          this.assignedWorkerIds.set(event.operatorId, event.workerIds);
          break;
        case "ExecutionDurationUpdateEvent":
          this.anchorDuration(event.duration, event.isRunning);
          break;
        case "RequestRefusedEvent":
          this.handleRefusedRequest(event);
          break;
        default:
          // workflow status related event
          this.handleReconfigurationEvent(event);
          const newState = this.handleExecutionEvent(event);
          if (newState !== undefined) {
            this.updateExecutionState(newState);
          }
      }
    });

    // A unit whose socket is down shows no run: the Dashboard service is asked about the one this page follows.
    workflowWebsocketService.getConnectionStatusStream().subscribe(connected => {
      this.socketConnected = connected;
      if (!connected) {
        this.followAtDashboard();
      }
    });

    // Ends an in-flight run once its unit is gone or Failed and the socket is down; console and results are kept.
    // A run is in flight from the moment it is asked for: one that has not reached the unit is given up, so
    // nothing of it is sent there later. A run whose execution this page follows is not ended here: the
    // Dashboard service says how it went.
    combineLatest([
      computingUnitStatusService.getSelectedComputingUnit(),
      workflowWebsocketService.getConnectionStatusStream(),
    ]).subscribe(([unit, connected]) => {
      const unitLost = unit === null || unit.status === "Failed";
      const runInFlight = !this.pendingRun.closed || this.isExecutionInFlight(this.currentState.state);
      if (!connected && unitLost && runInFlight && this.followedExecutionId === undefined) {
        this.resetExecutionAndWorkers();
      }
    });
  }

  public handleReconfigurationEvent(event: TexeraWebsocketEvent) {
    switch (event.type) {
      case "ModifyLogicResponse":
        if (!event.isValid) {
          this.notificationService.error(event.errorMessage);
        } else {
          this.notificationService.info("reconfiguration registered");
        }
        return;
      case "ModifyLogicCompletedEvent":
        this.notificationService.info("reconfiguration on operator(s) " + event.opIds + " complete");
    }
  }

  /**
   * A request of this page that the computing unit did not do. The refusal says nothing about the run the unit
   * holds, so the run on screen stays as it is and the user is told why in a notification. Only the start
   * this page waits for is the run on screen itself: refused, that run has failed, with why as its error.
   */
  private handleRefusedRequest(refusal: RequestRefusedEvent): void {
    const refusesAwaitedStart =
      refusal.request === "WorkflowStartRequest" &&
      this.awaitedStart !== undefined &&
      refusal.executionId === this.awaitedStart;
    if (refusesAwaitedStart) {
      this.awaitedStart = undefined;
      // The refusal is how this run ended on this page: nothing the Dashboard holds of it takes its place.
      this.unfollow();
      this.updateExecutionState({ state: ExecutionState.Failed, errorMessages: [startFailure(refusal.message)] });
    } else {
      this.notificationService.error(refusal.message);
    }
  }

  public handleExecutionEvent(event: TexeraWebsocketEvent): ExecutionStateInfo | undefined {
    switch (event.type) {
      case "WorkflowStateEvent":
        // The unit names the execution its state is of, and none with the state of no run.
        this.currentExecutionId = event.executionId;
        if (event.executionId !== undefined) {
          // The run the unit holds: the one this page asked for, or one another page started meanwhile.
          this.awaitedStart = undefined;
          // It is the run to follow, and its unit shows it: the unit's word is the state on screen.
          this.follow(event.executionId);
        } else if (this.isFollowedRunInFlight()) {
          // The state of no run is what every new socket is told first, and all that a unit which holds no
          // run says: it is not the end of the run on screen. That run stays as it is, and the Dashboard
          // service is asked about it until the unit names it again.
          this.followAtDashboard();
          return undefined;
        }
        let newState = ExecutionState[event.state];
        switch (newState) {
          case ExecutionState.Paused:
            if (this.currentState.state === ExecutionState.Paused) {
              return this.currentState;
            } else {
              return { state: ExecutionState.Paused, currentTuples: {} };
            }
          case ExecutionState.Failed:
            // for failed state, backend will send an additional message after this status event.
            return undefined;
          default:
            return { state: newState };
        }
      case "RecoveryStartedEvent":
        return { state: ExecutionState.Recovering };
      case "OperatorCurrentTuplesUpdateEvent":
        let pausedCurrentTuples: Readonly<Record<string, OperatorCurrentTuples>>;
        if (this.currentState.state === ExecutionState.Paused) {
          pausedCurrentTuples = this.currentState.currentTuples;
        } else {
          pausedCurrentTuples = {};
        }
        const currentTupleUpdate: Record<string, OperatorCurrentTuples> = {};
        currentTupleUpdate[event.operatorID] = event;
        const newCurrentTuples: Record<string, OperatorCurrentTuples> = {
          ...currentTupleUpdate,
          ...pausedCurrentTuples,
        };
        return {
          state: ExecutionState.Paused,
          currentTuples: newCurrentTuples,
        };
      case "WorkflowErrorEvent":
        return {
          state: ExecutionState.Failed,
          errorMessages: event.fatalErrors.map(err => {
            return { ...err, message: err.message.replace("\\n", "<br>") };
          }),
        };
      default:
        return undefined;
    }
  }

  public getExecutionState(): ExecutionStateInfo {
    return this.currentState;
  }

  /**
   * The execution of the run on screen, for a request about what that run stored; undefined while the
   * computing unit names none, as before a run and for a run whose unit no longer shows it.
   */
  public getCurrentExecutionId(): number | undefined {
    return this.currentExecutionId;
  }

  /** How long the current run has been going, worked out from the anchor. */
  public getExecutionDuration(): number {
    const { reported, at, isRunning } = this.durationAnchor;
    return isRunning ? reported + (Date.now() - at) : reported;
  }

  /**
   * The run clock, ticking while a run is going. Both views read it from here rather than each
   * running their own timer off the backend event: that timer sat downstream of the event, so a
   * view that mounted after the run started never received one and never began counting.
   */
  public getExecutionDurationStream(): Observable<number> {
    return this.executionDuration.asObservable();
  }

  private anchorDuration(reported: number, isRunning: boolean): void {
    this.durationAnchor = { reported, at: Date.now(), isRunning };
    this.durationTicker?.unsubscribe();
    this.durationTicker = isRunning
      ? interval(1000).subscribe(() => this.executionDuration.next(this.getExecutionDuration()))
      : undefined;
    this.executionDuration.next(this.getExecutionDuration());
  }

  /**
   * Apply the graph lock the current execution state implies, for a view that arrived on a workflow
   * whose run was already in flight.
   *
   * The lock is otherwise only reapplied when the state changes (see `updateExecutionState`), so a
   * view that unlocked the graph on arrival left a workflow that was still running editable until
   * its run happened to end. The rule itself stays in the one place that owns it.
   *
   * Deliberately silent. `executionStateStream` carries transitions, not a current value, and
   * re-announcing the state as `previous -> current` of the same state would be a transition that
   * never happened: the result panel would read it as a run just finishing, and the canvas editor
   * throws outright on any event whose `previous` is `Recovering` and whose `current` is not one of
   * the states recovery can end in. A view that needs the current state reads `getExecutionState()`
   * -- as the menu does when it is constructed, and as the Form View does before it settles in.
   */
  public reapplyExecutionLock(): void {
    this.updateWorkflowActionLock(this.currentState);
  }

  /**
   * Whether the state on screen is of a run its computing unit does not show, and so is what the Dashboard
   * service answers for the run's execution. The unit cannot be asked to pause, resume or kill such a run,
   * and, once its socket is up, it is free to start another.
   */
  public isFollowingAtDashboard(): boolean {
    return this.followingAtDashboard.value;
  }

  /** {@link isFollowingAtDashboard}, now and at each change. */
  public getFollowingAtDashboardStream(): Observable<boolean> {
    return this.followingAtDashboard.asObservable();
  }

  public getErrorMessages(): ReadonlyArray<WorkflowFatalError> {
    if (this.currentState?.state === ExecutionState.Failed) {
      return this.currentState.errorMessages;
    }
    return [];
  }

  /**
   * Returns whether the run was asked for, so a caller that reports on it does not have to
   * repeat the refusal conditions. False means this method turned the run down locally --
   * no computing unit, no warehouse -- and showed its own toast. True only means the run's
   * execution is being asked for: the Dashboard service can still refuse to create it, and the
   * computing unit to start it, which arrives on the execution state stream. Callers that only
   * fire and forget can keep ignoring the result.
   */
  public executeWorkflowWithEmailNotification(
    executionName: string,
    emailNotificationEnabled: boolean,
    targetOperatorId?: string
  ): boolean {
    const logicalPlan = ExecuteWorkflowService.getLogicalPlanRequest(
      this.workflowActionService.getTexeraGraph(),
      targetOperatorId
    );
    return this.requestExecution(executionName, logicalPlan, emailNotificationEnabled);
  }

  /** Returns whether the run was asked for; see executeWorkflowWithEmailNotification. */
  public executeWorkflow(executionName: string, targetOperatorId?: string): boolean {
    return this.executeWorkflowWithEmailNotification(executionName, false, targetOperatorId);
  }

  public executeWorkflowWithReplay(replayExecutionInfo: ReplayExecutionInfo): void {
    const logicalPlan = ExecuteWorkflowService.getLogicalPlanRequest(this.workflowActionService.getTexeraGraph());
    this.requestExecution(
      `Replay run of ${replayExecutionInfo.eid} to ${replayExecutionInfo.interaction}`,
      logicalPlan,
      false,
      replayExecutionInfo
    );
  }

  /**
   * Asks for a run of `logicalPlan` on the selected computing unit, unless the run is turned down here, with
   * a toast. Every check comes before resetExecutionState(), so a refused click keeps the results on screen.
   * Returns whether the run was asked for; see executeWorkflowWithEmailNotification.
   */
  private requestExecution(
    executionName: string,
    logicalPlan: LogicalPlan,
    emailNotificationEnabled: boolean,
    replayFromExecution?: ReplayExecutionInfo
  ): boolean {
    if (this.refuseToRunOnUnavailableUnit()) {
      return false;
    }
    // An execution is created for a saved workflow, to run on a computing unit. Only a saved workflow has a
    // unit selected, so whichever of the two is missing, the unit is what to ask for.
    const wid = this.workflowActionService.getWorkflowMetadata().wid;
    const computingUnitId = this.computingUnitStatusService.getSelectedComputingUnitValue()?.computingUnit.cuid;
    if (!wid || computingUnitId === undefined) {
      this.notificationService.error("Create or select a computing unit before running.");
      return false;
    }
    if (this.refuseToRunWithoutWarehouse()) {
      return false;
    }
    this.resetExecutionState();
    this.workflowStatusService.resetStatus();
    this.createThenStart({
      wid,
      executionName,
      engineVersion: version.buildNumber,
      logicalPlan,
      workflowSettings: this.workflowActionService.getWorkflowSettings(),
      emailNotificationEnabled,
      computingUnitId,
      // The warehouse this execution writes to (#7817): none while per-user warehouses are disabled.
      warehouseId: this.warehouseService.getSelectedWarehouseIdValue(),
      replayFromExecution,
    });
    return true;
  }

  /**
   * Has the Dashboard service create the execution `request` asks for, then asks the computing unit, over
   * the websocket, to start it with the plan the Dashboard answered with. An execution the Dashboard does not
   * create fails the run with the errors it reports, and nothing is sent to the unit: the run it holds, and that
   * run's results, stay as they are.
   */
  private createThenStart(request: CreateExecutionRequest): void {
    // The run asked for last is the one that starts, and the one whose start is waited for. It takes the place
    // of the run this page followed.
    this.pendingRun.unsubscribe();
    this.awaitedStart = undefined;
    this.unfollow();
    // wait for the form debounce to complete, then create the execution
    this.pendingRun = timer(FORM_DEBOUNCE_TIME_MS)
      .pipe(
        // The unit reports a run only once it has built it: until then the run shows as starting from here.
        tap(() => this.updateExecutionState({ state: ExecutionState.Initializing })),
        switchMap(() => this.executionApiService.create(request))
      )
      .subscribe({
        next: ({ eid, plan }) => {
          this.currentExecutionId = eid;
          this.awaitedStart = eid;
          // The unit is taken to show the run it is asked to start, until it says that it holds none. A unit
          // whose socket is down is asked nothing yet.
          this.follow(eid);
          if (!this.socketConnected) {
            this.followAtDashboard();
          }
          this.workflowWebsocketService.send("WorkflowStartRequest", { executionId: eid, plan });
        },
        error: (error: unknown) =>
          this.updateExecutionState({
            state: ExecutionState.Failed,
            errorMessages: errorsOfFailedCreate(error, request.logicalPlan),
          }),
      });
  }

  /**
   * Refuses to run on a unit that cannot accept work: shows a toast and returns true. The run
   * buttons already disable themselves, but run-up-to and Time Travel replay call this service
   * directly.
   *
   * Checked before resetExecutionState(), so a refused click keeps the results on screen, and
   * before the warehouse check, since a warehouse cannot fix a dead unit.
   */
  private refuseToRunOnUnavailableUnit(): boolean {
    const reason = unavailableComputingUnitReason(
      this.computingUnitStatusService.getSelectedComputingUnitValue()?.status
    );
    if (reason === undefined) {
      return false;
    }
    this.notificationService.error(
      reason === "terminating"
        ? "The selected computing unit is shutting down. Wait for it to finish, then select or create another one."
        : "The selected computing unit is unavailable. Select a running unit or create a new one."
    );
    return true;
  }

  /**
   * While the deployment requires a warehouse (#7817) and none is picked,
   * refuses with a toast and returns true. Checked for every public entry
   * point before the previous execution's state is reset — a refused click
   * must not wipe the results already on screen (#7751 adds the backend-side
   * rejection).
   */
  private refuseToRunWithoutWarehouse(): boolean {
    if (!this.config.env.warehouseEnabled || this.warehouseService.getSelectedWarehouseIdValue() !== undefined) {
      return false;
    }
    this.notificationService.error("Create or select a warehouse before running.");
    return true;
  }

  public pauseWorkflow(): void {
    if (this.currentState === undefined || this.currentState.state !== ExecutionState.Running) {
      throw new Error("cannot pause workflow, the current execution state is " + this.currentState?.state);
    }
    this.workflowWebsocketService.send("WorkflowPauseRequest", {
      executionId: this.executionOnScreen("pause workflow"),
    });
  }

  public killWorkflow(): void {
    if (
      this.currentState.state === ExecutionState.Uninitialized ||
      this.currentState.state === ExecutionState.Completed
    ) {
      throw new Error("cannot kill workflow, the current execution state is " + this.currentState.state);
    }
    if (!this.pendingRun.closed) {
      // The run has not reached the computing unit: it is given up here. A kill sent now would end the run
      // the unit still holds, the one before it.
      this.pendingRun.unsubscribe();
      this.updateExecutionState({ state: ExecutionState.Killed });
      return;
    }
    this.workflowWebsocketService.send("WorkflowKillRequest", { executionId: this.executionOnScreen("kill workflow") });
  }

  public takeGlobalCheckpoint(): void {
    if (
      this.currentState.state === ExecutionState.Uninitialized ||
      this.currentState.state === ExecutionState.Completed
    ) {
      throw new Error("cannot take checkpoint, the current execution state is " + this.currentState.state);
    }
    this.workflowWebsocketService.send("WorkflowCheckpointRequest", {});
  }

  public resumeWorkflow(): void {
    if (this.currentState.state !== ExecutionState.Paused) {
      throw new Error("cannot resume workflow, the current execution state is " + this.currentState.state);
    }
    this.workflowWebsocketService.send("WorkflowResumeRequest", {
      executionId: this.executionOnScreen("resume workflow"),
    });
  }

  /**
   * The execution of the run on screen, for a request that names the run it is for; `request` says what is
   * asked, for the error of a run whose execution is not known.
   */
  private executionOnScreen(request: string): number {
    if (this.currentExecutionId === undefined) {
      throw new Error(`cannot ${request}, the computing unit has not named the execution it runs`);
    }
    return this.currentExecutionId;
  }

  public skipTuples(workers: ReadonlyArray<string>): void {
    if (this.currentState.state !== ExecutionState.Paused) {
      throw new Error("cannot skip tuples, the current execution state is " + this.currentState.state);
    }
    this.workflowWebsocketService.send("SkipTupleRequest", { workers });
  }

  public retryExecution(workers: ReadonlyArray<string>): void {
    if (this.currentState.state !== ExecutionState.Paused) {
      throw new Error("cannot retry the current tuple, the current execution state is " + this.currentState.state);
    }
    this.workflowWebsocketService.send("RetryRequest", { workers });
  }

  /**
   * Snapshots the workflow that changes to the paused run's operators are compiled against: called as an operator
   * is unlocked for a logic change, before anything is edited. The editor is locked while a run is in flight, so
   * what it holds then is what the run ran, the whole of it, which may be more than a run up to an operator ran.
   * A snapshot already taken is kept, as the editor holds the changes made since.
   */
  public snapshotWorkflowForLogicChange(): void {
    if (this.currentState.state !== ExecutionState.Paused || this.workflowSnapshot !== undefined) {
      return;
    }
    this.workflowSnapshot = ExecuteWorkflowService.getLogicalPlanRequest(this.workflowActionService.getTexeraGraph());
  }

  /**
   * Changes operator `operatorID` of the paused run to what the editor holds: the Dashboard service compiles the
   * change against the workflow snapshot ({@link snapshotWorkflowForLogicChange}), for the execution the computing
   * unit names as the paused one, and the change it answers with is handed to the unit, which answers with a
   * ModifyLogicResponse. A change with no snapshot, or one the Dashboard does not compile, is reported in a toast,
   * and nothing is sent to the unit.
   */
  public modifyOperatorLogic(operatorID: string): void {
    if (this.currentState.state !== ExecutionState.Paused) {
      throw new Error("cannot modify logic, the current execution state is " + this.currentState.state);
    }
    const executionId = this.executionOnScreen("modify logic");
    const workflow = this.workflowSnapshot;
    if (workflow === undefined) {
      this.notificationService.error(
        "The change was not sent: unlock the operator for a logic change before changing it."
      );
      return;
    }
    const op = this.workflowActionService.getTexeraGraph().getOperator(operatorID);
    const operator: LogicalOperator = {
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
    };
    this.executionApiService.postUpdate(executionId, operator, workflow).subscribe({
      next: ({ update }) => this.workflowWebsocketService.send("OperatorUpdateRequest", { executionId, update }),
      error: (error: unknown) => this.notificationService.error(failureMessage(error)),
    });
  }

  public getExecutionStateStream(): Observable<{
    previous: ExecutionStateInfo;
    current: ExecutionStateInfo;
  }> {
    return this.executionStateStream.asObservable();
  }

  public getRegionUpdateStream(): Observable<RegionUpdateEvent> {
    return this.regionUpdateStream.asObservable();
  }

  public getRegionStateStream(): Observable<RegionStateEvent> {
    return this.regionStateStream.asObservable();
  }

  public resetExecutionState(): void {
    this.currentState = {
      state: ExecutionState.Uninitialized,
    };
    // Otherwise the next workflow's menu opens showing the previous run's time.
    this.anchorDuration(0, false);
  }

  /**
   * Reset execution status and worker assignments. Unlike resetExecutionState(),
   * this also clears worker assignments and broadcasts the reset on
   * executionStateStream so subscribers drop the previous unit's status.
   */
  public resetExecutionAndWorkers(): void {
    // A run still on its way, and the execution the unit named, belong to the session that is reset: the one
    // must not start in the next session, and the other is not the next session's to change, or to follow.
    this.pendingRun.unsubscribe();
    this.currentExecutionId = undefined;
    this.awaitedStart = undefined;
    this.unfollow();
    this.updateExecutionState({ state: ExecutionState.Uninitialized });
    this.assignedWorkerIds.clear();
    // Leaving the workspace takes this path, not resetExecutionState, so the clock has to be
    // stopped here as well: otherwise the next workflow opens showing the last run's time, and
    // if that run was still going, showing it still counting up.
    this.anchorDuration(0, false);
  }

  /** Follows execution `eid`, which its unit shows, in place of the one followed before. */
  private follow(eid: number): void {
    if (eid !== this.followedExecutionId) {
      this.workflowSnapshot = undefined;
    }
    this.followedExecutionId = eid;
    this.stopFollowingAtDashboard();
  }

  private unfollow(): void {
    this.followedExecutionId = undefined;
    this.workflowSnapshot = undefined;
    this.stopFollowingAtDashboard();
  }

  private isFollowedRunInFlight(): boolean {
    return this.followedExecutionId !== undefined && this.isExecutionInFlight(this.currentState.state);
  }

  /**
   * Asks the Dashboard service for the state of the followed execution from now on, as its unit has stopped
   * showing the run: every {@link FOLLOWED_EXECUTION_POLL_INTERVAL_MS}, and the first time that long from now,
   * so that a unit which only lost its socket names the run again first. Does nothing for a run that is not in
   * flight, and while the Dashboard is being asked already. A question that fails is asked again at the next
   * turn, and none is asked while the one before it is unanswered.
   */
  private followAtDashboard(): void {
    const eid = this.followedExecutionId;
    if (eid === undefined || !this.isFollowedRunInFlight() || !this.dashboardPoll.closed) {
      return;
    }
    this.dashboardPoll = timer(FOLLOWED_EXECUTION_POLL_INTERVAL_MS, FOLLOWED_EXECUTION_POLL_INTERVAL_MS)
      .pipe(exhaustMap(() => this.executionApiService.getState(eid).pipe(catchError(() => EMPTY))))
      .subscribe(answer => this.showAnsweredState(answer));
    this.followingAtDashboard.next(true);
  }

  private stopFollowingAtDashboard(): void {
    this.dashboardPoll.unsubscribe();
    if (this.followingAtDashboard.value) {
      this.followingAtDashboard.next(false);
    }
  }

  /**
   * Shows the state the Dashboard service answers for the followed execution. An open execution is asked
   * about again; a closed one has ended for good as far as this page follows it, with the outcome answered.
   */
  private showAnsweredState(answer: ExecutionStateResponse): void {
    if (!answer.open) {
      if (this.awaitedStart === this.followedExecutionId) {
        this.awaitedStart = undefined;
      }
      this.unfollow();
    }
    const state = stateAnsweredFor(answer, this.currentState);
    if (state === undefined) {
      return;
    }
    if (!this.isExecutionInFlight(state.state) && this.durationAnchor.isRunning) {
      // The unit that would have reported what the run took is not there to: the clock stops where it is.
      this.anchorDuration(this.getExecutionDuration(), false);
    }
    this.updateExecutionState(state);
  }

  private isExecutionInFlight(state: ExecutionState): boolean {
    switch (state) {
      case ExecutionState.Initializing:
      case ExecutionState.Running:
      case ExecutionState.Pausing:
      case ExecutionState.Paused:
      case ExecutionState.Resuming:
      case ExecutionState.Recovering:
        return true;
      case ExecutionState.Uninitialized:
      case ExecutionState.Completed:
      case ExecutionState.Terminated:
      case ExecutionState.Failed:
      case ExecutionState.Killed:
        return false;
      default:
        return exhaustiveGuard(state);
    }
  }

  private updateExecutionState(stateInfo: ExecutionStateInfo): void {
    if (isEqual(this.currentState, stateInfo)) {
      return;
    }
    if (stateInfo.state !== ExecutionState.Paused) {
      this.workflowSnapshot = undefined;
    }
    this.updateWorkflowActionLock(stateInfo);
    const previousState = this.currentState;
    // update current state
    this.currentState = stateInfo;
    // emit event
    this.executionStateStream.next({
      previous: previousState,
      current: this.currentState,
    });
  }

  /**
   * enables or disables workflow action service based on execution state
   */
  private updateWorkflowActionLock(stateInfo: ExecutionStateInfo): void {
    if (this.isExecutionInFlight(stateInfo.state)) {
      this.workflowActionService.disableWorkflowModification();
    } else {
      this.workflowActionService.enableWorkflowModification();
    }
  }

  /**
   * Transform a workflowGraph object to the HTTP request body according to the backend API.
   *
   * All the operators in the workflowGraph will be transformed to LogicalOperator objects,
   *  where each operator has an operatorID and operatorType along with
   *  the properties of the operator.
   *
   * All the links in the workflowGraph will be transformed to LogicalLink objects,
   *  where each link will store its source id as its origin and target id as its destination.
   *
   * @param workflowGraph
   * @param targetOperatorId
   */
  public static getLogicalPlanRequest(workflowGraph: WorkflowGraphReadonly, targetOperatorId?: string): LogicalPlan {
    const getInputPortOrdinal = (operatorID: string, inputPortID: string): number => {
      return workflowGraph.getOperator(operatorID).inputPorts.findIndex(port => port.portID === inputPortID);
    };

    const getOutputPortOrdinal = (operatorID: string, outputPortID: string): number => {
      return workflowGraph.getOperator(operatorID).outputPorts.findIndex(port => port.portID === outputPortID);
    };
    const subDAG = workflowGraph.getSubDAG(targetOperatorId);

    const operators: LogicalOperator[] = subDAG.operators.map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    const links: LogicalLink[] = subDAG.links.map(link => {
      const outputPortIdx = getOutputPortOrdinal(link.source.operatorID, link.source.portID);
      const inputPortIdx = getInputPortOrdinal(link.target.operatorID, link.target.portID);
      return {
        fromOpId: link.source.operatorID,
        fromPortId: { id: outputPortIdx, internal: false },
        toOpId: link.target.operatorID,
        toPortId: { id: inputPortIdx, internal: false },
      };
    });

    const operatorIds = new Set(subDAG.operators.map(op => op.operatorID));

    const opsToViewResult: string[] = Array.from(intersection(operatorIds, workflowGraph.getOperatorsToViewResult()));

    const opsToReuseResult: string[] = Array.from(
      intersection(operatorIds, workflowGraph.getOperatorsMarkedForReuseResult())
    );

    return { operators, links, opsToViewResult, opsToReuseResult };
  }

  public getWorkerIds(operatorId: string): ReadonlyArray<string> {
    return this.assignedWorkerIds.get(operatorId) || [];
  }
}
