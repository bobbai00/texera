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
  combineLatest,
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
  failureMessage,
  operatorErrorsOf,
  ReplayExecutionInfo,
} from "./execution-api.service";

// TODO: change this declaration
export const FORM_DEBOUNCE_TIME_MS = 150;

/**
 * The errors of a run of `plan` whose execution the Dashboard service did not create, `error` being how the
 * request for it failed. For a workflow that does not compile: each operator's error, an operator before
 * those downstream of it. For any other failure: its reason, as one error that belongs to no operator, which
 * is how the computing unit reports a start it refuses.
 */
function errorsOfFailedCreate(error: unknown, plan: LogicalPlan): ReadonlyArray<WorkflowFatalError> {
  const operatorErrors = operatorErrorsOf(error, plan);
  if (operatorErrors !== undefined) {
    return operatorErrors;
  }
  const now = Date.now();
  return [
    {
      type: { name: "EXECUTION_FAILURE" },
      timestamp: { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1_000_000 },
      message: failureMessage(error),
      details: "",
      operatorId: "",
      workerId: "",
    },
  ];
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
   * The execution of the run the computing unit holds, as the unit names it with each state it reports: the
   * one a change to an operator is stored for while its run is paused, whichever page started the run.
   */
  private currentExecutionId?: number;

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
        default:
          // workflow status related event
          this.handleReconfigurationEvent(event);
          const newState = this.handleExecutionEvent(event);
          if (newState !== undefined) {
            this.updateExecutionState(newState);
          }
      }
    });

    // Ends an in-flight run once its unit is gone or Failed and the socket is down; console and results are kept.
    // A run is in flight from the moment it is asked for: one that has not reached the unit is given up, so
    // nothing of it is sent there later.
    combineLatest([
      computingUnitStatusService.getSelectedComputingUnit(),
      workflowWebsocketService.getConnectionStatusStream(),
    ]).subscribe(([unit, connected]) => {
      const unitLost = unit === null || unit.status === "Failed";
      const runInFlight = !this.pendingRun.closed || this.isExecutionInFlight(this.currentState.state);
      if (!connected && unitLost && runInFlight) {
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

  public handleExecutionEvent(event: TexeraWebsocketEvent): ExecutionStateInfo | undefined {
    switch (event.type) {
      case "WorkflowStateEvent":
        // The unit names the execution its state is of, and none with the state of no run.
        this.currentExecutionId = event.executionId;
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
   * the websocket, to start it from the plan the Dashboard wrote. An execution the Dashboard does not create
   * fails the run with the errors it reports, and nothing is sent to the unit: the run it holds, and that
   * run's results, stay as they are.
   */
  private createThenStart(request: CreateExecutionRequest): void {
    // The run asked for last is the one that starts.
    this.pendingRun.unsubscribe();
    // wait for the form debounce to complete, then create the execution
    this.pendingRun = timer(FORM_DEBOUNCE_TIME_MS)
      .pipe(
        // The unit reports a run only once it has built it: until then the run shows as starting from here.
        tap(() => this.updateExecutionState({ state: ExecutionState.Initializing })),
        switchMap(() => this.executionApiService.create(request))
      )
      .subscribe({
        next: ({ eid, planUri }) =>
          this.workflowWebsocketService.send("WorkflowStartRequest", { executionId: eid, planUri }),
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
    this.workflowWebsocketService.send("WorkflowPauseRequest", {});
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
    this.workflowWebsocketService.send("WorkflowKillRequest", {});
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
    this.workflowWebsocketService.send("WorkflowResumeRequest", {});
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
   * Changes operator `operatorID` of the paused run to what the editor holds: the change is stored at the
   * Dashboard service, for the execution the computing unit names as the paused one, then named to the unit,
   * which answers with a ModifyLogicResponse and applies it when the run resumes. A change the Dashboard does
   * not store is reported in a toast, and nothing is sent to the unit.
   */
  public modifyOperatorLogic(operatorID: string): void {
    if (this.currentState.state !== ExecutionState.Paused) {
      throw new Error("cannot modify logic, the current execution state is " + this.currentState.state);
    }
    const executionId = this.currentExecutionId;
    if (executionId === undefined) {
      throw new Error("cannot modify logic, the computing unit has not named the paused execution");
    }
    const op = this.workflowActionService.getTexeraGraph().getOperator(operatorID);
    const operator: LogicalOperator = {
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
    };
    this.executionApiService.postUpdate(executionId, operator).subscribe({
      next: ({ updateId }) => this.workflowWebsocketService.send("OperatorUpdateRequest", { executionId, updateId }),
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
    // must not start in the next session, and the other is not the next session's to change.
    this.pendingRun.unsubscribe();
    this.currentExecutionId = undefined;
    this.updateExecutionState({ state: ExecutionState.Uninitialized });
    this.assignedWorkerIds.clear();
    // Leaving the workspace takes this path, not resetExecutionState, so the clock has to be
    // stopped here as well: otherwise the next workflow opens showing the last run's time, and
    // if that run was still going, showing it still counting up.
    this.anchorDuration(0, false);
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
