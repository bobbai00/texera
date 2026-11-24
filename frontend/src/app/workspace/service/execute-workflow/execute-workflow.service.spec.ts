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

import "zone.js/testing";

import { DOCUMENT } from "@angular/core";
import { ExecutionState, ExecutionStateInfo, LogicalPlan } from "../../types/execute-workflow.interface";
import { fakeAsync, inject, TestBed, tick } from "@angular/core/testing";

import {
  ExecuteWorkflowService,
  FOLLOWED_EXECUTION_POLL_INTERVAL_MS,
  FORM_DEBOUNCE_TIME_MS,
} from "./execute-workflow.service";

import { DEFAULT_WORKFLOW, WorkflowActionService } from "../workflow-graph/model/workflow-action.service";
import { UndoRedoService } from "../undo-redo/undo-redo.service";
import { OperatorMetadataService } from "../operator-metadata/operator-metadata.service";
import { StubOperatorMetadataService } from "../operator-metadata/stub-operator-metadata.service";
import { JointUIService } from "../joint-ui/joint-ui.service";
import { BehaviorSubject, Subject } from "rxjs";
import { WorkflowWebsocketService } from "../workflow-websocket/workflow-websocket.service";
import { WorkflowStatusService } from "../workflow-status/workflow-status.service";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { GuiConfigService } from "../../../common/service/gui-config.service";

import { mockLogicalPlan_scan_result, mockWorkflowPlan_scan_result } from "./mock-workflow-plan";
import { HttpClientTestingModule, HttpTestingController, TestRequest } from "@angular/common/http/testing";
import { WorkflowUtilService } from "../workflow-graph/util/workflow-util.service";

import { ExecutionMode, WorkflowSettings } from "src/app/common/type/workflow";
import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { DashboardWorkflowComputingUnit } from "../../../common/type/workflow-computing-unit";
import { WarehouseService } from "../../../common/service/warehouse/warehouse.service";
import { AuthService } from "src/app/common/service/user/auth.service";
import { StubAuthService } from "src/app/common/service/user/stub-auth.service";
import { UserService } from "src/app/common/service/user/user.service";
import { StubUserService } from "src/app/common/service/user/stub-user.service";
import { MockComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/mock-computing-unit-status.service";
import { commonTestProviders } from "../../../common/testing/test-utils";
import { RegionStateEvent, RegionUpdateEvent, TexeraWebsocketEvent } from "../../types/workflow-websocket.interface";
import {
  mockPoint,
  mockResultPredicate,
  mockScanPredicate,
  mockScanResultLink,
} from "../workflow-graph/model/mock-workflow-data";
import { Version } from "src/environments/version";
import { CreateExecutionResponse, ExecutionStateResponse, ReplayExecutionInfo } from "./execution-api.service";

describe("ExecuteWorkflowService", () => {
  // Where the Dashboard service creates executions, and the workflow and the computing unit the specs run on.
  const EXECUTIONS_URL = "api/executions";
  const WID = 12;
  const CUID = 3;

  let service: ExecuteWorkflowService;
  let httpMock: HttpTestingController;
  let mockDocument: Document;
  let selectedUnit$: BehaviorSubject<DashboardWorkflowComputingUnit | null>;
  let connected$: BehaviorSubject<boolean>;

  /** Selects a computing unit in `status`, or none. */
  const selectUnit = (status: DashboardWorkflowComputingUnit["status"] | undefined, cuid: number = CUID): void => {
    vi.spyOn(service["computingUnitStatusService"], "getSelectedComputingUnitValue").mockReturnValue(
      status === undefined ? null : ({ computingUnit: { cuid }, status } as unknown as DashboardWorkflowComputingUnit)
    );
  };

  /** Opens workflow `wid`: none for a workflow that is not saved yet. */
  const openWorkflow = (wid: number | undefined): void => {
    TestBed.inject(WorkflowActionService).setWorkflowMetadata({ ...DEFAULT_WORKFLOW, wid });
  };

  /** The frames the service sends to the computing unit from here on. */
  const spyOnSocket = () => vi.spyOn(TestBed.inject(WorkflowWebsocketService), "send");

  /** Lets the form debounce pass, and hands back the request for an execution the Dashboard then holds. */
  const expectCreate = (): TestRequest => {
    tick(FORM_DEBOUNCE_TIME_MS);
    return httpMock.expectOne(EXECUTIONS_URL);
  };

  /** Lets the form debounce pass, and checks that the Dashboard was asked for no execution. */
  const expectNoCreate = (): void => {
    tick(FORM_DEBOUNCE_TIME_MS);
    httpMock.expectNone(EXECUTIONS_URL);
  };

  /** The plan the Dashboard compiles for execution `eid`: text that only the computing unit reads. */
  const planOf = (eid: number): string => `{"executionId":${eid},"operators":[{"id":"ScanSource-1","layer":"main"}]}`;

  /** The Dashboard's answer for execution `eid`, once it is created. */
  const created = (eid: number): CreateExecutionResponse => ({ eid, plan: planOf(eid) });

  /** Runs the workflow until the computing unit is asked to start execution `eid`. */
  const startExecution = (eid: number): void => {
    service.executeWorkflow("run");
    expectCreate().flush(created(eid), { status: 201, statusText: "Created" });
  };

  beforeEach(() => {
    mockDocument = {
      location: {
        origin: "https://texera.example.com",
      },
    } as Document;

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        ExecuteWorkflowService,
        WorkflowActionService,
        WorkflowUtilService,
        { provide: ComputingUnitStatusService, useClass: MockComputingUnitStatusService },
        UndoRedoService,
        JointUIService,
        {
          provide: OperatorMetadataService,
          useClass: StubOperatorMetadataService,
        },
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: AuthService, useClass: StubAuthService },
        { provide: UserService, useClass: StubUserService },
        ...commonTestProviders,
      ],
    });

    // Install the selected-unit and connection streams before the service is constructed. The socket
    // starts out up, so no run is reset until a test drops it.
    selectedUnit$ = new BehaviorSubject<DashboardWorkflowComputingUnit | null>(null);
    vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getSelectedComputingUnit").mockReturnValue(
      selectedUnit$.asObservable()
    );
    connected$ = new BehaviorSubject<boolean>(true);
    vi.spyOn(TestBed.inject(WorkflowWebsocketService), "getConnectionStatusStream").mockReturnValue(
      connected$.asObservable()
    );
    service = TestBed.inject(ExecuteWorkflowService);
    httpMock = TestBed.inject(HttpTestingController);
    // What a run needs: a saved workflow, open on a computing unit that accepts work.
    openWorkflow(WID);
    selectUnit("Running");
  });

  afterEach(() => {
    // A spec that mocks the static getLogicalPlanRequest must not hand its plan to the next one.
    vi.restoreAllMocks();
    // A spec that leaves a run its unit does not show must not go on asking the Dashboard about it.
    service.resetExecutionAndWorkers();
    // Every request for an execution was expected by its spec.
    httpMock.verify();
  });

  // Push an event through the stream the real WorkflowWebsocketService exposes, so the
  // constructor subscription in ExecuteWorkflowService runs exactly as it would in production.
  // websocketEvent() publicly returns the underlying Subject; casting to Subject for the test
  // avoids reaching into the service's private fields.
  const emitWsEvent = (event: TexeraWebsocketEvent): void => {
    (TestBed.inject(WorkflowWebsocketService).websocketEvent() as Subject<TexeraWebsocketEvent>).next(event);
  };

  it("should be created", inject([ExecuteWorkflowService], (injectedService: ExecuteWorkflowService) => {
    expect(injectedService).toBeTruthy();
  }));

  // A view handed a session mid-run subscribes after the last state change, and the stream carries
  // no current value, so it heard nothing about the run: it showed Run for a workflow that was
  // running. The lock is reapplied only when the state changes too, so a canvas that unlocked the
  // graph on arrival left a running workflow editable until the run happened to end.
  // The backend sends ExecutionDurationUpdateEvent exactly twice in a run: once just after
  // startTimeStamp is written, carrying a few milliseconds, and once when endTimeStamp is. So the
  // reported number stands still for the whole run, and a view that mounted in between and hung a
  // timer off that event never received one and never started counting. The clock is anchored and
  // ticked here instead, and replayed to whoever subscribes.
  describe("the run clock", () => {
    const emitDuration = (duration: number, isRunning: boolean) =>
      emitWsEvent({ type: "ExecutionDurationUpdateEvent", duration, isRunning } as TexeraWebsocketEvent);

    it("counts on from the reported value while the run is going, rather than repeating it", () => {
      vi.useFakeTimers();
      try {
        // What the backend actually sends at the start of a run: a handful of milliseconds.
        emitDuration(3, true);
        vi.advanceTimersByTime(60_000);

        // A view mounting a minute in asks and is told a minute, not 3ms.
        expect(service.getExecutionDuration()).toBeGreaterThanOrEqual(60_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("hands a view that subscribes mid-run the clock straight away, then ticks it", () => {
      vi.useFakeTimers();
      try {
        emitDuration(0, true);
        vi.advanceTimersByTime(30_000);

        const seen: number[] = [];
        service.getExecutionDurationStream().subscribe(d => seen.push(d));
        expect(seen[0]).toBeGreaterThanOrEqual(30_000);

        vi.advanceTimersByTime(1000);
        expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(31_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops counting once the run ends, and reports what the run took", () => {
      vi.useFakeTimers();
      try {
        emitDuration(0, true);
        vi.advanceTimersByTime(10_000);
        // The second and last event: the real total.
        emitDuration(12_345, false);
        vi.advanceTimersByTime(10_000);

        expect(service.getExecutionDuration()).toBe(12_345);
      } finally {
        vi.useRealTimers();
      }
    });

    // Otherwise the next workflow's menu opens showing the previous run's time.
    it("goes back to zero when the execution state is reset", () => {
      emitDuration(9999, false);

      service.resetExecutionState();

      expect(service.getExecutionDuration()).toBe(0);
    });

    // Leaving the workspace takes this path, not resetExecutionState, and a run still going when
    // it is taken would otherwise carry on counting into the next workflow.
    it("stops a running clock when the execution and workers are reset", () => {
      vi.useFakeTimers();
      try {
        emitDuration(0, true);
        vi.advanceTimersByTime(20_000);

        service.resetExecutionAndWorkers();
        const atReset = service.getExecutionDuration();
        vi.advanceTimersByTime(20_000);

        expect(atReset).toBe(0);
        expect(service.getExecutionDuration()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // A view handed a session mid-run needs the lock the run implies; the lock is otherwise only
  // reapplied when the state changes, so a canvas that unlocked on arrival left a running workflow
  // editable until its run happened to end.
  describe("reapplyExecutionLock", () => {
    it("reapplies the lock the current state implies, rather than unlocking outright", () => {
      const actionService = service["workflowActionService"];
      const enable = vi.spyOn(actionService, "enableWorkflowModification");
      const disable = vi.spyOn(actionService, "disableWorkflowModification");

      // Uninitialized: nothing is running, so the graph may be edited.
      service.reapplyExecutionLock();
      expect(enable).toHaveBeenCalled();
      expect(disable).not.toHaveBeenCalled();

      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      enable.mockClear();
      disable.mockClear();

      // Running: the graph stays locked, which is the case the canvas's hand-over got wrong.
      service.reapplyExecutionLock();
      expect(disable).toHaveBeenCalled();
      expect(enable).not.toHaveBeenCalled();
    });

    // The stream carries transitions. Repeating the current state as `previous -> current` of the
    // same state is a transition that never happened: the result panel reads one as a run just
    // finishing, and the canvas editor throws on any event whose `previous` is Recovering and whose
    // `current` is not a state recovery can end in -- which a Recovering -> Recovering repeat is.
    it("says nothing on the state stream, so no transition is invented", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Recovering });
      const seen: ExecutionStateInfo[] = [];
      service.getExecutionStateStream().subscribe(({ current }) => seen.push(current));

      service.reapplyExecutionLock();

      expect(seen).toEqual([]);
    });
  });

  describe("losing the selected computing unit mid-run", () => {
    const unit = (cuid: number, status: DashboardWorkflowComputingUnit["status"] = "Running") =>
      ({ computingUnit: { cuid }, status }) as unknown as DashboardWorkflowComputingUnit;

    // The usual order: the socket errors at once, the unit list catches up on its next poll.
    it("keeps the run when the socket drops on a healthy unit, then ends it once the selection empties", () => {
      const enable = vi.spyOn(service["workflowActionService"], "enableWorkflowModification");
      const seen: ExecutionState[] = [];
      service.getExecutionStateStream().subscribe(({ current }) => seen.push(current.state));
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      emitWsEvent({ type: "WorkerAssignmentUpdateEvent", operatorId: "op1", workerIds: ["w1", "w2"] });
      selectedUnit$.next(unit(7));
      enable.mockClear();

      connected$.next(false);
      expect(service.getExecutionState().state).toBe(ExecutionState.Running);

      selectedUnit$.next(null);
      expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
      expect(service.getWorkerIds("op1")).toEqual([]);
      expect(enable).toHaveBeenCalled();
      expect(seen).toEqual([ExecutionState.Running, ExecutionState.Uninitialized]);
    });

    // Another tab disconnecting a local unit empties this tab's selection while this tab's socket
    // to the engine, and so Kill, still work.
    it("keeps the run when the selection empties with the socket still up, then ends it once the socket drops", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      selectedUnit$.next(unit(7));

      selectedUnit$.next(null);
      expect(service.getExecutionState().state).toBe(ExecutionState.Running);

      connected$.next(false);
      expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
    });

    // An evicted or crash-looping unit stays selected and reports Failed instead of leaving the list.
    it("ends the run when the selected unit reports Failed with the socket down", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      selectedUnit$.next(unit(7));
      connected$.next(false);

      selectedUnit$.next(unit(7, "Failed"));

      expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
    });

    it("keeps the run when the selected unit reports Failed with the socket still up", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      selectedUnit$.next(unit(7));

      selectedUnit$.next(unit(7, "Failed"));

      expect(service.getExecutionState().state).toBe(ExecutionState.Running);
    });

    it("ends a later run as well when its unit is lost too", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
      selectedUnit$.next(unit(7));
      connected$.next(false);
      selectedUnit$.next(null);
      selectedUnit$.next(unit(8));
      connected$.next(true);
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });

      connected$.next(false);
      selectedUnit$.next(null);

      expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
    });

    it.each([
      ExecutionState.Initializing,
      ExecutionState.Running,
      ExecutionState.Pausing,
      ExecutionState.Paused,
      ExecutionState.Resuming,
      ExecutionState.Recovering,
    ])("ends a run that is %s when its unit is lost", state => {
      (service as any).currentState = { state };
      selectedUnit$.next(unit(7));
      connected$.next(false);

      selectedUnit$.next(null);

      expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
    });

    it.each([
      ExecutionState.Uninitialized,
      ExecutionState.Completed,
      ExecutionState.Terminated,
      ExecutionState.Failed,
      ExecutionState.Killed,
    ])("leaves a run that is %s untouched when its unit is lost", state => {
      const before = { state };
      (service as any).currentState = before;
      selectedUnit$.next(unit(7));
      connected$.next(false);

      selectedUnit$.next(null);

      expect(service.getExecutionState()).toBe(before);
    });

    it.each([
      ["switching straight from one unit to another", unit(7), unit(8)],
      ["a unit is first selected", null, unit(7)],
      ["the selected unit is still Running", unit(7), unit(7)],
      ["the selected unit reports Pending", unit(7), unit(7, "Pending")],
      ["the selected unit reports Unknown", unit(7), unit(7, "Unknown")],
      ["the selected unit reports Terminating", unit(7), unit(7, "Terminating")],
    ])("keeps the run with the socket down when %s", (_case, selected, next) => {
      connected$.next(false);
      selectedUnit$.next(selected);
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });

      selectedUnit$.next(next);

      expect(service.getExecutionState().state).toBe(ExecutionState.Running);
    });

    // A run reaches its unit in two steps, and the unit can be lost before the second: the run is given up
    // where it stands, and nothing of it is sent to the unit afterwards.
    it("gives up a run that is waiting for the form debounce when its unit is lost", fakeAsync(() => {
      selectedUnit$.next(unit(CUID));
      service.executeWorkflow("run");

      connected$.next(false);
      selectedUnit$.next(null);

      expectNoCreate();
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
    }));

    it("gives up a run whose execution is being created when its unit is lost, and starts nothing", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      selectedUnit$.next(unit(CUID));
      service.executeWorkflow("run");
      const create = expectCreate();
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });

      connected$.next(false);
      selectedUnit$.next(null);

      expect(create.cancelled).toBe(true);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
      expect(wsSendSpy).not.toHaveBeenCalled();
    }));

    // Its execution is the Dashboard's to close: the page shows how it ended, in place of going back to idle.
    it("keeps a run whose execution it follows when its unit is lost, and asks the Dashboard how it went", fakeAsync(() => {
      selectedUnit$.next(unit(CUID));
      startExecution(345);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });

      connected$.next(false);
      selectedUnit$.next(unit(CUID, "Failed"));

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      tick(FOLLOWED_EXECUTION_POLL_INTERVAL_MS);
      httpMock
        .expectOne(`${EXECUTIONS_URL}/345/state`)
        .flush({ eid: 345, status: 4, open: false, reason: "unit lost", timeMs: 1794873600000 });
      expect(service.getExecutionState().state).toBe(ExecutionState.Failed);
      expect(service.getErrorMessages().map(error => error.message)).toEqual(["unit lost"]);
    }));

    it("keeps a run the unit named when the selection empties with the socket down", fakeAsync(() => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
      emitWsEvent({ type: "WorkerAssignmentUpdateEvent", operatorId: "op1", workerIds: ["w1"] });
      selectedUnit$.next(unit(7));

      connected$.next(false);
      selectedUnit$.next(null);

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      expect(service.getWorkerIds("op1")).toEqual(["w1"]);
      service.resetExecutionAndWorkers();
    }));

    // The socket redials a healthy unit, and hands it what was sent meanwhile.
    it("keeps a run whose execution is being created when the socket drops on a healthy unit", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      selectedUnit$.next(unit(CUID));
      service.executeWorkflow("run");
      const create = expectCreate();

      connected$.next(false);
      create.flush(created(345), { status: 201, statusText: "Created" });

      expect(wsSendSpy.mock.calls).toEqual([["WorkflowStartRequest", { plan: planOf(345) }]]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      // The unit reports the run it was handed before the Dashboard would be asked about it.
      connected$.next(true);
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Initializing, executionId: 345 });
      tick(FOLLOWED_EXECUTION_POLL_INTERVAL_MS);
      httpMock.expectNone(`${EXECUTIONS_URL}/345/state`);
    }));
  });

  // A caller that must refuse a structural edit mid-run asks here rather than re-listing the states,
  // and a view whose own lock no longer means "a run is on" -- the Form View clamps it off outside
  // edit mode -- has nowhere else honest to ask.
  describe("isExecutionInFlight", () => {
    it("answers for each state exactly as the graph lock does", () => {
      const actionService = service["workflowActionService"];
      const disable = vi.spyOn(actionService, "disableWorkflowModification");

      expect(service.isExecutionInFlight()).toBe(false); // Uninitialized

      for (const state of [
        ExecutionState.Initializing,
        ExecutionState.Running,
        ExecutionState.Pausing,
        ExecutionState.Paused,
        ExecutionState.Resuming,
        ExecutionState.Recovering,
      ]) {
        disable.mockClear();
        emitWsEvent({ type: "WorkflowStateEvent", state });
        expect(service.isExecutionInFlight(), state).toBe(true);
        expect(disable, state).toHaveBeenCalled();
      }

      for (const state of [ExecutionState.Completed, ExecutionState.Failed, ExecutionState.Killed]) {
        emitWsEvent({ type: "WorkflowStateEvent", state });
        expect(service.isExecutionInFlight(), state).toBe(false);
      }
    });
  });

  it("resetExecutionAndWorkers() clears the execution state and worker assignments", () => {
    (service as any).currentState = { state: ExecutionState.Running };
    (service as any).assignedWorkerIds.set("op1", ["w1", "w2"]);

    const emittedStates: ExecutionState[] = [];
    service.getExecutionStateStream().subscribe(event => emittedStates.push(event.current.state));

    service.resetExecutionAndWorkers();

    expect(service.getExecutionState().state).toBe(ExecutionState.Uninitialized);
    expect(service.getWorkerIds("op1")).toEqual([]);
    // must broadcast on the stream so subscribers (menu, result panel) drop stale status
    expect(emittedStates).toContain(ExecutionState.Uninitialized);
  });

  it("should generate a logical plan request based on the workflow graph that is passed to the function", () => {
    const newLogicalPlan: LogicalPlan = ExecuteWorkflowService.getLogicalPlanRequest(mockWorkflowPlan_scan_result);
    expect(newLogicalPlan).toEqual(mockLogicalPlan_scan_result);
  });

  // ---- a run: its execution is created at the Dashboard service, then started on the unit -----

  describe("running the workflow", () => {
    it("creates the execution at the Dashboard, then hands the unit its plan to start it with", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      const states: ExecutionState[] = [];
      service.getExecutionStateStream().subscribe(event => states.push(event.current.state));

      expect(service.executeWorkflow("run-1")).toBe(true);

      // Nothing leaves the browser until the form debounce has passed.
      tick(FORM_DEBOUNCE_TIME_MS - 1);
      httpMock.expectNone(EXECUTIONS_URL);
      expect(states).toEqual([]);

      tick(1);
      const create = httpMock.expectOne(EXECUTIONS_URL);
      expect(create.request.method).toBe("POST");
      // While the Dashboard creates the execution the run shows as starting, and the unit has heard nothing.
      expect(states).toEqual([ExecutionState.Initializing]);
      expect(wsSendSpy).not.toHaveBeenCalled();

      create.flush(created(345), { status: 201, statusText: "Created" });

      // The plan as the Dashboard answered it, text the page does not read.
      expect(wsSendSpy).toHaveBeenCalledTimes(1);
      expect(wsSendSpy).toHaveBeenCalledWith("WorkflowStartRequest", { plan: planOf(345) });
      // The unit's own "Initializing", once it has built the run, is the state the run already shows.
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Initializing, executionId: 345 });
      expect(states).toEqual([ExecutionState.Initializing]);
    }));

    it("asks for an execution of the open workflow, on the selected unit, as the editor holds it", fakeAsync(() => {
      vi.spyOn(ExecuteWorkflowService, "getLogicalPlanRequest").mockReturnValue(mockLogicalPlan_scan_result);
      const settings: WorkflowSettings = { dataTransferBatchSize: 123, executionMode: ExecutionMode.MATERIALIZED };
      TestBed.inject(WorkflowActionService).setWorkflowSettings(settings);
      selectUnit("Running", 99);

      service.executeWorkflowWithEmailNotification("exec", true);

      const create = expectCreate();
      expect(create.request.body).toEqual({
        wid: WID,
        executionName: "exec",
        engineVersion: Version.buildNumber,
        logicalPlan: mockLogicalPlan_scan_result,
        workflowSettings: settings,
        emailNotificationEnabled: true,
        computingUnitId: 99,
      });
      // Neither a warehouse nor a replay was asked for, so neither is written.
      expect(Object.keys(JSON.parse(create.request.serializeBody() as string)).sort()).toEqual([
        "computingUnitId",
        "emailNotificationEnabled",
        "engineVersion",
        "executionName",
        "logicalPlan",
        "wid",
        "workflowSettings",
      ]);
    }));

    it("starts only the run asked for last, when another is asked for before its execution is created", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();

      // Asked for twice before the form debounce passes: one execution.
      service.executeWorkflow("first");
      tick(FORM_DEBOUNCE_TIME_MS - 1);
      service.executeWorkflow("second");
      const second = expectCreate();
      expect(second.request.body.executionName).toBe("second");

      // Asked for again while the Dashboard creates it: that request is given up.
      service.executeWorkflow("third");
      expect(second.cancelled).toBe(true);
      const third = expectCreate();
      third.flush(created(7), { status: 201, statusText: "Created" });

      expect(wsSendSpy).toHaveBeenCalledTimes(1);
      expect(wsSendSpy).toHaveBeenCalledWith("WorkflowStartRequest", { plan: planOf(7) });
    }));

    it("fails the run when the unit refuses the start this page waits for, and leaves Run usable", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);
      startExecution(345);

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 was already started.",
      });

      // The refusal is the run's one error, of no operator: whoever shows the run's failure shows it.
      expect(service.getExecutionState()).toEqual({
        state: ExecutionState.Failed,
        errorMessages: [
          {
            type: { name: "EXECUTION_FAILURE" },
            timestamp: { seconds: expect.any(Number), nanos: expect.any(Number) },
            message: "Execution 345 was already started.",
            details: "",
            operatorId: "",
            workerId: "",
          },
        ],
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
      // Only the start went to the unit.
      expect(wsSendSpy).toHaveBeenCalledTimes(1);
    }));
  });

  // ---- a request the unit does not do ------------------------------------------------------------

  describe("a request the computing unit refuses", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);
    });

    it("fails the run for a refused start that names no execution: one whose plan the unit could not read", fakeAsync(() => {
      startExecution(345);

      // The unit names the execution a refused start's plan named, and none where it could not read the plan.
      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        message: "The plan is in format version 2, but this reader reads version 1.",
      });

      expect(service.getExecutionState().state).toEqual(ExecutionState.Failed);
      expect(service.getErrorMessages().map(error => error.message)).toEqual([
        "The plan is in format version 2, but this reader reads version 1.",
      ]);
      expect(errorSpy).not.toHaveBeenCalled();
    }));

    it("does not fail a run for a refused start that names no execution, when the page waits for none", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        message: "The request carries no plan.",
      });

      expect(errorSpy.mock.calls).toEqual([["The request carries no plan."]]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
    });

    /** The states the page showed, from here on. */
    const statesShown = (): ExecutionState[] => {
      const states: ExecutionState[] = [];
      service.getExecutionStateStream().subscribe(event => states.push(event.current.state));
      return states;
    };

    it("is told in a notification, and leaves the run on screen as it is", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
      const states = statesShown();

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowKillRequest",
        executionId: 345,
        message: "You do not have write access to the computing unit.",
      });
      // A frame the unit could not read names no request and no execution.
      emitWsEvent({ type: "RequestRefusedEvent", message: "The request could not be read." });

      expect(errorSpy.mock.calls).toEqual([
        ["You do not have write access to the computing unit."],
        ["The request could not be read."],
      ]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      expect(states).toEqual([]);
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(false);
    });

    it("does not fail a run for a refused start of another execution than the one it waits for", fakeAsync(() => {
      startExecution(345);

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 344,
        message: "Execution 344 was already started.",
      });
      // Not a start at all, though it names the execution waited for.
      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowKillRequest",
        executionId: 345,
        message: "Execution 345 is not running here.",
      });

      expect(errorSpy.mock.calls).toEqual([
        ["Execution 344 was already started."],
        ["Execution 345 is not running here."],
      ]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
    }));

    it("does not fail a run the unit has started, for a later refusal of its start", fakeAsync(() => {
      startExecution(345);
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 was already started.",
      });

      expect(errorSpy.mock.calls).toEqual([["Execution 345 was already started."]]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
    }));

    it("does not fail a run another page started meanwhile, for the refused start this page asked for", fakeAsync(() => {
      startExecution(345);
      // Another page's run took the screen before the unit answered this page's start.
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 400 });

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 could not be claimed for its start. Run the workflow again.",
      });

      expect(errorSpy.mock.calls).toEqual([
        ["Execution 345 could not be claimed for its start. Run the workflow again."],
      ]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
    }));

    it("does not fail a later run for the refused start of the run it took the place of", fakeAsync(() => {
      startExecution(345);
      // Asked for again before the unit answered: the page now waits for the later run.
      service.executeWorkflow("run");
      const create = expectCreate();

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 could not be claimed for its start. Run the workflow again.",
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      create.flush(created(346), { status: 201, statusText: "Created" });
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
    }));

    it("does not fail the next session's run for a start refused after the page was reset", fakeAsync(() => {
      startExecution(345);
      service.resetExecutionAndWorkers();

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 was already started.",
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
    }));
  });

  // ---- an execution the Dashboard does not create ----------------------------------------------

  describe("an execution the Dashboard does not create", () => {
    /** A compile error as the Dashboard writes it: with what its protobuf class adds to the fields read here. */
    const compileError = (operatorId: string, message: string) => ({
      type: {
        value: 0,
        index: 0,
        name: "COMPILATION_ERROR",
        compilationError: true,
        executionFailure: false,
        unrecognized: false,
      },
      timestamp: { seconds: 1794835321, nanos: 239851266, unknownFields: { fields: {} } },
      message,
      details: `Stack trace for developers: \n\n${message}`,
      operatorId,
      workerId: "",
    });

    it("fails the run with each operator's compile error, an operator before those downstream of it", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      const states: ExecutionState[] = [];
      service.getExecutionStateStream().subscribe(event => states.push(event.current.state));
      // A scan and the filter that reads it, which the editor lists first.
      vi.spyOn(ExecuteWorkflowService, "getLogicalPlanRequest").mockReturnValue({
        operators: [
          { operatorID: "Filter-operator-a", operatorType: "Filter" },
          { operatorID: "CSVFileScan-operator-b", operatorType: "CSVFileScan" },
        ],
        links: [
          {
            fromOpId: "CSVFileScan-operator-b",
            fromPortId: { id: 0, internal: false },
            toOpId: "Filter-operator-a",
            toPortId: { id: 0, internal: false },
          },
        ],
        opsToViewResult: [],
        opsToReuseResult: [],
      });
      const scanError = compileError("CSVFileScan-operator-b", "java.lang.RuntimeException: No file selected");
      const filterError = compileError("Filter-operator-a", "region is not contained in the schema");

      service.executeWorkflow("run");
      // The answer keys the errors by operator, here with the filter's first.
      expectCreate().flush(
        {
          code: 400,
          message: "The workflow does not compile: 2 operators have errors.",
          eid: 345,
          operatorErrors: { [filterError.operatorId]: filterError, [scanError.operatorId]: scanError },
        },
        { status: 400, statusText: "Bad Request" }
      );

      expect(states).toEqual([ExecutionState.Initializing, ExecutionState.Failed]);
      // Each as the Dashboard wrote it, the cause of the filter's error first.
      expect(service.getErrorMessages()).toEqual([scanError, filterError]);
      // Nothing reached the unit: the run it holds, and that run's results, are as they were.
      expect(wsSendSpy).not.toHaveBeenCalled();
      // Run is usable again, and so is the editor.
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
    }));

    // One `it` per answer: it.each does not run its body in the zone fakeAsync needs.
    const refusals: { status: number; statusText: string; message: string }[] = [
      { status: 400, statusText: "Bad Request", message: "You have no warehouse with id 9." },
      { status: 403, statusText: "Forbidden", message: "You may not run workflows on computing unit 3." },
      { status: 409, statusText: "Conflict", message: "Computing unit 3 is terminated." },
      {
        status: 500,
        statusText: "Server Error",
        message: "Execution 345 could not be created: its plan could not be made.",
      },
    ];
    for (const { status, statusText, message } of refusals) {
      it(`fails the run with the reason the Dashboard gives for answering ${status}`, fakeAsync(() => {
        const wsSendSpy = spyOnSocket();

        service.executeWorkflow("run");
        expectCreate().flush({ code: status, message }, { status, statusText });

        // One error that belongs to no operator, as the unit reports a start it refuses.
        expect(service.getErrorMessages()).toEqual([
          {
            type: { name: "EXECUTION_FAILURE" },
            timestamp: { seconds: expect.any(Number), nanos: expect.any(Number) },
            message,
            details: "",
            operatorId: "",
            workerId: "",
          },
        ]);
        expect(service.getExecutionState().state).toBe(ExecutionState.Failed);
        expect(wsSendSpy).not.toHaveBeenCalled();
      }));
    }

    it("fails the run saying that the Dashboard could not be reached, for a request that got no answer", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();

      service.executeWorkflow("run");
      expectCreate().error(new ProgressEvent("error"), { status: 0, statusText: "Unknown Error" });

      expect(service.getErrorMessages().map(error => error.message)).toEqual([
        "The Dashboard service could not be reached.",
      ]);
      expect(wsSendSpy).not.toHaveBeenCalled();
    }));

    it("lets the workflow run again", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      service.executeWorkflow("run");
      expectCreate().flush(
        { code: 409, message: "Computing unit 3 is terminated." },
        { status: 409, statusText: "Conflict" }
      );

      startExecution(346);

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      expect(wsSendSpy).toHaveBeenCalledTimes(1);
      expect(wsSendSpy).toHaveBeenCalledWith("WorkflowStartRequest", { plan: planOf(346) });
    }));
  });

  it("it should raise an error when pauseWorkflow() is called without an execution state", () => {
    (service as any).currentState = { state: ExecutionState.Uninitialized };
    expect(function () {
      service.pauseWorkflow();
    }).toThrowError(
      new RegExp("cannot pause workflow, the current execution state is " + (service as any).currentState.state)
    );
  });

  it("it should raise an error when resumeWorkflow() is called without an execution state", () => {
    (service as any).currentState = { state: ExecutionState.Uninitialized };
    expect(function () {
      service.resumeWorkflow();
    }).toThrowError(
      new RegExp("cannot resume workflow, the current execution state is " + (service as any).currentState.state)
    );
  });

  it("should execute workflow with email notification successfully", fakeAsync(() => {
    const executionName = "Test Execution";
    const emailNotificationEnabled = true;
    const targetOperatorId = "test-operator-id";
    const logicalPlan = { operators: [], links: [] } as LogicalPlan;
    const settings = { dataTransferBatchSize: 7 } as WorkflowSettings;

    const logicalPlanSpy = vi.spyOn(ExecuteWorkflowService, "getLogicalPlanRequest").mockReturnValue(logicalPlan);
    const settingsSpy = vi.spyOn(service["workflowActionService"], "getWorkflowSettings").mockReturnValue(settings);
    const resetExecutionStateSpy = vi.spyOn(service, "resetExecutionState");
    const resetStatusSpy = vi.spyOn(service["workflowStatusService"], "resetStatus");

    const asked = service.executeWorkflowWithEmailNotification(
      executionName,
      emailNotificationEnabled,
      targetOperatorId
    );

    expect(asked).toBe(true);
    expect(logicalPlanSpy).toHaveBeenCalledWith(service["workflowActionService"].getTexeraGraph(), targetOperatorId);
    expect(settingsSpy).toHaveBeenCalled();
    expect(resetExecutionStateSpy).toHaveBeenCalled();
    expect(resetStatusSpy).toHaveBeenCalled();
    expect(expectCreate().request.body).toEqual(
      expect.objectContaining({
        executionName,
        logicalPlan,
        workflowSettings: settings,
        emailNotificationEnabled,
      })
    );
  }));

  it("should handle failure when executing workflow with email notification", fakeAsync(() => {
    const executionName = "Test Execution";
    const emailNotificationEnabled = true;
    const targetOperatorId = "test-operator-id";

    const logicalPlanSpy = vi.spyOn(ExecuteWorkflowService, "getLogicalPlanRequest").mockImplementation(() => {
      throw "Logical plan error";
    });
    const resetExecutionStateSpy = vi.spyOn(service, "resetExecutionState");
    const resetStatusSpy = vi.spyOn(service["workflowStatusService"], "resetStatus");

    expect(() => {
      service.executeWorkflowWithEmailNotification(executionName, emailNotificationEnabled, targetOperatorId);
    }).toThrowError("Logical plan error");

    expect(logicalPlanSpy).toHaveBeenCalledWith(service["workflowActionService"].getTexeraGraph(), targetOperatorId);
    expect(resetExecutionStateSpy).not.toHaveBeenCalled();
    expect(resetStatusSpy).not.toHaveBeenCalled();
    expectNoCreate();
  }));

  // ---- constructor: websocket-event routing --------------------------------------------------

  it("routes region and worker-assignment websocket events to their dedicated streams", () => {
    const regionUpdates: RegionUpdateEvent[] = [];
    const regionStates: RegionStateEvent[] = [];
    service.getRegionUpdateStream().subscribe(event => regionUpdates.push(event));
    service.getRegionStateStream().subscribe(event => regionStates.push(event));

    emitWsEvent({ type: "RegionUpdateEvent", regions: [] });
    emitWsEvent({ type: "RegionStateEvent", id: 7, state: "COMPLETED" });
    emitWsEvent({ type: "WorkerAssignmentUpdateEvent", operatorId: "opX", workerIds: ["w1", "w2"] });

    expect(regionUpdates).toEqual([{ type: "RegionUpdateEvent", regions: [] }]);
    expect(regionStates).toEqual([{ type: "RegionStateEvent", id: 7, state: "COMPLETED" }]);
    expect(service.getWorkerIds("opX")).toEqual(["w1", "w2"]);
  });

  it("routes execution-status websocket events into the execution-state stream", () => {
    const states: ExecutionState[] = [];
    service.getExecutionStateStream().subscribe(event => states.push(event.current.state));

    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });

    expect(service.getExecutionState().state).toBe(ExecutionState.Running);
    expect(states).toEqual([ExecutionState.Running]);
  });

  it("does not re-emit when a websocket event maps to the unchanged execution state", () => {
    const states: ExecutionState[] = [];
    service.getExecutionStateStream().subscribe(event => states.push(event.current.state));

    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });

    // second identical event is deduped by updateExecutionState's isEqual guard
    expect(states).toEqual([ExecutionState.Running]);
  });

  // ---- handleReconfigurationEvent ------------------------------------------------------------

  it("handleReconfigurationEvent shows an error notification for an invalid ModifyLogicResponse", () => {
    const errorSpy = vi.spyOn(service["notificationService"], "error").mockImplementation(() => undefined as any);
    service.handleReconfigurationEvent({
      type: "ModifyLogicResponse",
      opId: "1",
      isValid: false,
      errorMessage: "boom",
    });
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  it("handleReconfigurationEvent confirms a valid ModifyLogicResponse", () => {
    const infoSpy = vi.spyOn(service["notificationService"], "info").mockImplementation(() => undefined as any);
    service.handleReconfigurationEvent({ type: "ModifyLogicResponse", opId: "1", isValid: true, errorMessage: "" });
    expect(infoSpy).toHaveBeenCalledWith("reconfiguration registered");
  });

  it("handleReconfigurationEvent announces a ModifyLogicCompletedEvent with the operator ids", () => {
    const infoSpy = vi.spyOn(service["notificationService"], "info").mockImplementation(() => undefined as any);
    service.handleReconfigurationEvent({ type: "ModifyLogicCompletedEvent", opIds: ["a", "b"] });
    expect(infoSpy).toHaveBeenCalledWith("reconfiguration on operator(s) a,b complete");
  });

  // ---- handleExecutionEvent ------------------------------------------------------------------

  it("handleExecutionEvent enters Paused with empty tuples from a non-paused state", () => {
    (service as any).currentState = { state: ExecutionState.Running };
    const result = service.handleExecutionEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused });
    expect(result).toEqual({ state: ExecutionState.Paused, currentTuples: {} });
  });

  it("handleExecutionEvent keeps the current state when already Paused", () => {
    const paused = { state: ExecutionState.Paused, currentTuples: { a: { operatorID: "a", tuples: [] } } };
    (service as any).currentState = paused;
    const result = service.handleExecutionEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused });
    expect(result).toBe(paused);
  });

  it("handleExecutionEvent defers the Failed state to the follow-up error event", () => {
    const result = service.handleExecutionEvent({ type: "WorkflowStateEvent", state: ExecutionState.Failed });
    expect(result).toBeUndefined();
  });

  it("handleExecutionEvent passes through other workflow states", () => {
    const result = service.handleExecutionEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
    expect(result).toEqual({ state: ExecutionState.Running });
  });

  it("handleExecutionEvent maps RecoveryStartedEvent to the Recovering state", () => {
    const result = service.handleExecutionEvent({ type: "RecoveryStartedEvent" });
    expect(result).toEqual({ state: ExecutionState.Recovering });
  });

  it("handleExecutionEvent merges current tuples on top of the existing paused tuples", () => {
    const existing = { opA: { operatorID: "opA", tuples: [] } };
    (service as any).currentState = { state: ExecutionState.Paused, currentTuples: existing };
    const event: TexeraWebsocketEvent = { type: "OperatorCurrentTuplesUpdateEvent", operatorID: "opB", tuples: [] };
    const result = service.handleExecutionEvent(event);
    expect(result).toEqual({
      state: ExecutionState.Paused,
      currentTuples: { opB: event, opA: existing.opA },
    });
  });

  it("handleExecutionEvent starts a fresh paused-tuples map when not already paused", () => {
    (service as any).currentState = { state: ExecutionState.Running };
    const event: TexeraWebsocketEvent = { type: "OperatorCurrentTuplesUpdateEvent", operatorID: "opB", tuples: [] };
    const result = service.handleExecutionEvent(event);
    expect(result).toEqual({ state: ExecutionState.Paused, currentTuples: { opB: event } });
  });

  it("handleExecutionEvent maps WorkflowErrorEvent to Failed and rewrites newline escapes", () => {
    const fatalError = {
      message: "line1\\nline2",
      details: "stack",
      operatorId: "op1",
      workerId: "w1",
      type: { name: "RuntimeError" },
      timestamp: { nanos: 1, seconds: 2 },
    };
    const result = service.handleExecutionEvent({ type: "WorkflowErrorEvent", fatalErrors: [fatalError] });
    expect(result).toEqual({
      state: ExecutionState.Failed,
      errorMessages: [{ ...fatalError, message: "line1<br>line2" }],
    });
  });

  it("handleExecutionEvent ignores unrelated events", () => {
    expect(service.handleExecutionEvent({ type: "HeartBeatResponse" })).toBeUndefined();
  });

  // ---- getErrorMessages ----------------------------------------------------------------------

  it("getErrorMessages returns the fatal errors while the execution is Failed", () => {
    const fatalError = {
      message: "boom",
      details: "stack",
      operatorId: "op1",
      workerId: "w1",
      type: { name: "RuntimeError" },
      timestamp: { nanos: 1, seconds: 2 },
    };
    (service as any).currentState = { state: ExecutionState.Failed, errorMessages: [fatalError] };
    expect(service.getErrorMessages()).toEqual([fatalError]);
  });

  // ---- execution entry points ----------------------------------------------------------------

  it("executeWorkflow delegates to executeWorkflowWithEmailNotification with email disabled", () => {
    const delegateSpy = vi.spyOn(service, "executeWorkflowWithEmailNotification").mockImplementation(() => true);
    service.executeWorkflow("run-1", "op-9");
    expect(delegateSpy).toHaveBeenCalledWith("run-1", false, "op-9");
  });

  it("executeWorkflowWithReplay asks for an execution that replays the interaction, then starts it", fakeAsync(() => {
    const logicalPlan = { operators: [], links: [] } as LogicalPlan;
    const logicalPlanSpy = vi.spyOn(ExecuteWorkflowService, "getLogicalPlanRequest").mockReturnValue(logicalPlan);
    const resetExecutionStateSpy = vi.spyOn(service, "resetExecutionState");
    const resetStatusSpy = vi.spyOn(service["workflowStatusService"], "resetStatus");
    const wsSendSpy = spyOnSocket();
    const replayInfo: ReplayExecutionInfo = { eid: 42, interaction: "step-3" };

    service.executeWorkflowWithReplay(replayInfo);

    expect(logicalPlanSpy).toHaveBeenCalledWith(service["workflowActionService"].getTexeraGraph());
    expect(resetExecutionStateSpy).toHaveBeenCalled();
    expect(resetStatusSpy).toHaveBeenCalled();
    const create = expectCreate();
    expect(create.request.body).toEqual(
      expect.objectContaining({
        executionName: "Replay run of 42 to step-3",
        logicalPlan,
        emailNotificationEnabled: false,
        replayFromExecution: replayInfo,
      })
    );

    create.flush(created(43), { status: 201, statusText: "Created" });

    expect(wsSendSpy).toHaveBeenCalledWith("WorkflowStartRequest", { plan: planOf(43) });
  }));

  // ---- refusing a run before it is asked for -------------------------------------------------

  it("a refused run leaves the previous execution's state untouched (#7817)", () => {
    TestBed.inject(GuiConfigService).env.warehouseEnabled = true;
    try {
      TestBed.inject(WarehouseService).selectWarehouse(undefined);
      const resetSpy = vi.spyOn(service, "resetExecutionState");
      const statusResetSpy = vi.spyOn(TestBed.inject(WorkflowStatusService), "resetStatus");
      vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.executeWorkflowWithEmailNotification("exec", false);

      expect(resetSpy).not.toHaveBeenCalled();
      expect(statusResetSpy).not.toHaveBeenCalled();
    } finally {
      TestBed.inject(GuiConfigService).env.warehouseEnabled = false;
    }
  });

  it("refuses to run without a warehouse while the deployment requires one (#7817)", fakeAsync(() => {
    // Paths that bypass the menu gate (form view, run-up-to, replay) all funnel
    // through this service; the shared storage must not catch them.
    TestBed.inject(GuiConfigService).env.warehouseEnabled = true;
    try {
      TestBed.inject(WarehouseService).selectWarehouse(undefined);
      const wsSendSpy = spyOnSocket();
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      expect(service.executeWorkflowWithEmailNotification("exec", false)).toBe(false);

      expectNoCreate();
      expect(wsSendSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith("Create or select a warehouse before running.");
    } finally {
      TestBed.inject(GuiConfigService).env.warehouseEnabled = false;
    }
  }));

  // ---- refusing to run on a unit that cannot accept work -------------------------------------

  describe("refusing to run on a computing unit that cannot accept work", () => {
    // Run-up-to and Time Travel replay bypass the run buttons and call this service directly,
    // so the service itself must refuse, before it resets the results on screen.
    const replayInfo: ReplayExecutionInfo = { eid: 42, interaction: "step-3" };

    const entryPoints: { name: string; run: () => void }[] = [
      {
        name: "executeWorkflowWithEmailNotification",
        run: () => service.executeWorkflowWithEmailNotification("e", false),
      },
      { name: "executeWorkflowWithReplay", run: () => service.executeWorkflowWithReplay(replayInfo) },
    ];

    // One `it` per status: it.each does not run its body in the zone fakeAsync needs.
    const refusedStatuses: { status: DashboardWorkflowComputingUnit["status"]; toast: string }[] = [
      {
        status: "Terminating",
        toast:
          "The selected computing unit is shutting down. Wait for it to finish, then select or create another one.",
      },
      {
        status: "Failed",
        toast: "The selected computing unit is unavailable. Select a running unit or create a new one.",
      },
      {
        status: "Unknown",
        toast: "The selected computing unit is unavailable. Select a running unit or create a new one.",
      },
    ];

    for (const entryPoint of entryPoints) {
      for (const { status, toast } of refusedStatuses) {
        it(`${entryPoint.name} refuses a ${status} unit and keeps the previous results on screen`, fakeAsync(() => {
          selectUnit(status);
          const wsSendSpy = spyOnSocket();
          const resetSpy = vi.spyOn(service, "resetExecutionState");
          const statusResetSpy = vi.spyOn(TestBed.inject(WorkflowStatusService), "resetStatus");
          const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

          entryPoint.run();

          expectNoCreate();
          expect(wsSendSpy).not.toHaveBeenCalled();
          expect(resetSpy).not.toHaveBeenCalled();
          expect(statusResetSpy).not.toHaveBeenCalled();
          expect(errorSpy).toHaveBeenCalledWith(toast);
        }));
      }

      for (const status of ["Running", "Pending"] as const) {
        it(`${entryPoint.name} still runs on a ${status} unit`, fakeAsync(() => {
          // Pending is still starting up, so it must not be blocked.
          selectUnit(status);
          const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

          entryPoint.run();

          expect(expectCreate().request.body.computingUnitId).toBe(CUID);
          expect(errorSpy).not.toHaveBeenCalled();
        }));
      }

      it(`${entryPoint.name} refuses to run with no unit selected and keeps the previous results on screen`, fakeAsync(() => {
        // Nothing to create the execution for. The run buttons lead to a unit instead of running, but
        // run-up-to, the AI fix and Time Travel replay come straight here.
        selectUnit(undefined);
        const wsSendSpy = spyOnSocket();
        const resetSpy = vi.spyOn(service, "resetExecutionState");
        const statusResetSpy = vi.spyOn(TestBed.inject(WorkflowStatusService), "resetStatus");
        const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

        entryPoint.run();

        expectNoCreate();
        expect(wsSendSpy).not.toHaveBeenCalled();
        expect(resetSpy).not.toHaveBeenCalled();
        expect(statusResetSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith("Create or select a computing unit before running.");
      }));
    }

    it("refuses on the unit before the warehouse, since a warehouse cannot rescue a dead unit", () => {
      TestBed.inject(GuiConfigService).env.warehouseEnabled = true;
      try {
        TestBed.inject(WarehouseService).selectWarehouse(undefined);
        selectUnit("Failed");
        const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

        service.executeWorkflowWithEmailNotification("e", false);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
          "The selected computing unit is unavailable. Select a running unit or create a new one."
        );
      } finally {
        TestBed.inject(GuiConfigService).env.warehouseEnabled = false;
      }
    });

    it("asks for a unit before a warehouse, and says the run was not asked for", () => {
      TestBed.inject(GuiConfigService).env.warehouseEnabled = true;
      try {
        TestBed.inject(WarehouseService).selectWarehouse(undefined);
        selectUnit(undefined);
        const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

        expect(service.executeWorkflow("e")).toBe(false);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith("Create or select a computing unit before running.");
      } finally {
        TestBed.inject(GuiConfigService).env.warehouseEnabled = false;
      }
    });

    // A workflow gets its id from its first save, and a unit only once it has one: 0 and no id
    // are both a workflow that is not saved yet.
    for (const unsaved of [undefined, 0]) {
      it(`refuses to run a workflow that is not saved yet (id ${unsaved})`, fakeAsync(() => {
        openWorkflow(unsaved);
        const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

        expect(service.executeWorkflow("e")).toBe(false);

        expectNoCreate();
        expect(errorSpy).toHaveBeenCalledWith("Create or select a computing unit before running.");
      }));
    }
  });

  it("asks for the execution in the picked warehouse, and in none when unset (#7817)", fakeAsync(() => {
    const warehouseService = TestBed.inject(WarehouseService);

    warehouseService.selectWarehouse(7);
    service.executeWorkflow("exec");
    expect(expectCreate().request.body.warehouseId).toBe(7);

    warehouseService.selectWarehouse(undefined);
    service.executeWorkflow("exec");
    // Left out of what is written, which the Dashboard reads as the shared default storage.
    expect(JSON.parse(expectCreate().request.serializeBody() as string)).not.toHaveProperty("warehouseId");
  }));

  // What a run stored is asked of the Dashboard service by its execution: the one on screen is the one the
  // unit named last, also once its run has ended, and none once the unit shows no run.
  it("getCurrentExecutionId names the execution of the run on screen, and none when the unit shows no run", () => {
    expect(service.getCurrentExecutionId()).toBeUndefined();

    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
    expect(service.getCurrentExecutionId()).toBe(345);
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Completed, executionId: 345 });
    expect(service.getCurrentExecutionId()).toBe(345);

    // A run another page started on the unit takes its place.
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 400 });
    expect(service.getCurrentExecutionId()).toBe(400);
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Completed, executionId: 400 });

    // What a new socket is told first, and all a unit that holds no run says.
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Uninitialized });
    expect(service.getCurrentExecutionId()).toBeUndefined();
  });

  // ---- control commands ----------------------------------------------------------------------

  it("pauseWorkflow sends a pause request while running, of the execution the unit named", () => {
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
    const wsSendSpy = spyOnSocket();
    service.pauseWorkflow();
    expect(wsSendSpy.mock.calls).toEqual([["WorkflowPauseRequest", { executionId: 345 }]]);
  });

  it("killWorkflow throws in a terminal state and sends a kill request otherwise, of the execution the unit named", () => {
    (service as any).currentState = { state: ExecutionState.Uninitialized };
    expect(() => service.killWorkflow()).toThrowError(
      "cannot kill workflow, the current execution state is Uninitialized"
    );

    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
    const wsSendSpy = spyOnSocket();
    service.killWorkflow();
    expect(wsSendSpy.mock.calls).toEqual([["WorkflowKillRequest", { executionId: 345 }]]);
  });

  // A page names the run it shows, so that the unit refuses a pause, a resume or a kill of a run another
  // has replaced since.
  it("names the execution the unit named last in a pause, a resume and a kill", () => {
    const wsSendSpy = spyOnSocket();
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 345 });
    // Another tab's run took its place on the unit.
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running, executionId: 400 });

    service.pauseWorkflow();
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused, executionId: 400 });
    service.resumeWorkflow();
    service.killWorkflow();

    expect(wsSendSpy.mock.calls).toEqual([
      ["WorkflowPauseRequest", { executionId: 400 }],
      ["WorkflowResumeRequest", { executionId: 400 }],
      ["WorkflowKillRequest", { executionId: 400 }],
    ]);
  });

  it("sends no pause, resume or kill of a run whose execution the unit has not named", () => {
    const wsSendSpy = spyOnSocket();
    const unnamed = "the computing unit has not named the execution it runs";

    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Running });
    expect(() => service.pauseWorkflow()).toThrowError(`cannot pause workflow, ${unnamed}`);
    expect(() => service.killWorkflow()).toThrowError(`cannot kill workflow, ${unnamed}`);
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused });
    expect(() => service.resumeWorkflow()).toThrowError(`cannot resume workflow, ${unnamed}`);

    expect(wsSendSpy).not.toHaveBeenCalled();
  });

  // The menu and the Form View offer to stop a run from the moment it shows as starting. Until its
  // execution is created the unit still holds the run before it, which a kill would end instead.
  it("killWorkflow gives up a run whose execution is still being created, and sends the unit nothing", fakeAsync(() => {
    const wsSendSpy = spyOnSocket();
    service.executeWorkflow("run");
    const create = expectCreate();

    service.killWorkflow();

    expect(create.cancelled).toBe(true);
    expect(service.getExecutionState()).toEqual({ state: ExecutionState.Killed });
    expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
    expect(wsSendSpy).not.toHaveBeenCalled();
  }));

  it("killWorkflow sends the unit a kill once it was asked to start the execution", fakeAsync(() => {
    const wsSendSpy = spyOnSocket();
    startExecution(345);

    service.killWorkflow();

    // The unit has not reported on the run yet: the kill names the execution it was asked to start.
    expect(wsSendSpy.mock.calls).toEqual([
      ["WorkflowStartRequest", { plan: planOf(345) }],
      ["WorkflowKillRequest", { executionId: 345 }],
    ]);
    // Killed is the unit's to report.
    expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
  }));

  it("killWorkflow sends the unit a kill for a run whose execution was not created", fakeAsync(() => {
    // A run elsewhere on the workflow that this page sees paused, after its own run was refused.
    const wsSendSpy = spyOnSocket();
    service.executeWorkflow("run");
    expectCreate().flush({ code: 403, message: "no" }, { status: 403, statusText: "Forbidden" });
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused, executionId: 400 });

    service.killWorkflow();

    expect(wsSendSpy.mock.calls).toEqual([["WorkflowKillRequest", { executionId: 400 }]]);
  }));

  it("takeGlobalCheckpoint throws when completed and sends a checkpoint request otherwise", () => {
    (service as any).currentState = { state: ExecutionState.Completed };
    expect(() => service.takeGlobalCheckpoint()).toThrowError(
      "cannot take checkpoint, the current execution state is Completed"
    );

    (service as any).currentState = { state: ExecutionState.Running };
    const wsSendSpy = vi.spyOn(service["workflowWebsocketService"], "send");
    service.takeGlobalCheckpoint();
    expect(wsSendSpy).toHaveBeenCalledWith("WorkflowCheckpointRequest", {});
  });

  it("resumeWorkflow sends a resume request while paused, of the execution the unit named", () => {
    emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused, executionId: 345 });
    const wsSendSpy = spyOnSocket();
    service.resumeWorkflow();
    expect(wsSendSpy.mock.calls).toEqual([["WorkflowResumeRequest", { executionId: 345 }]]);
  });

  it("skipTuples requires a paused state and forwards the workers", () => {
    (service as any).currentState = { state: ExecutionState.Running };
    expect(() => service.skipTuples(["w1"])).toThrowError("cannot skip tuples, the current execution state is Running");

    (service as any).currentState = { state: ExecutionState.Paused };
    const wsSendSpy = vi.spyOn(service["workflowWebsocketService"], "send");
    service.skipTuples(["w1", "w2"]);
    expect(wsSendSpy).toHaveBeenCalledWith("SkipTupleRequest", { workers: ["w1", "w2"] });
  });

  it("retryExecution requires a paused state and forwards the workers", () => {
    (service as any).currentState = { state: ExecutionState.Running };
    expect(() => service.retryExecution(["w1"])).toThrowError(
      "cannot retry the current tuple, the current execution state is Running"
    );

    (service as any).currentState = { state: ExecutionState.Paused };
    const wsSendSpy = vi.spyOn(service["workflowWebsocketService"], "send");
    service.retryExecution(["w9"]);
    expect(wsSendSpy).toHaveBeenCalledWith("RetryRequest", { workers: ["w9"] });
  });

  // ---- changing an operator of a paused run ----------------------------------------------------

  describe("modifyOperatorLogic", () => {
    const UPDATES_URL = `${EXECUTIONS_URL}/345/updates`;
    const NOT_SENT = "The change was not sent: unlock the operator for a logic change before changing it.";

    /** The unit reports the run of execution `executionId` in `state`, as it tells every session. */
    const unitReports = (state: ExecutionState, executionId?: number): void =>
      emitWsEvent({ type: "WorkflowStateEvent", state, executionId });

    /** The user unlocks an operator of the paused run for a logic change, before changing anything. */
    const unlock = (): void => service.snapshotWorkflowForLogicChange();

    /** The user sets the scan's table to `tableName`, which the editor holds from then on. */
    const editScan = (tableName: string): void =>
      TestBed.inject(WorkflowActionService).setOperatorProperty(mockScanPredicate.operatorID, { tableName });

    /** The scan once its table is `tableName`, as a change sends it: without the ports a plan's operators carry. */
    const scanChangedTo = (tableName: string) => ({ tableName, operatorID: "1", operatorType: "ScanSource" });

    /** The workflow every execution here runs, once the scan's table is `tableName`. */
    const workflowWithScanOf = (tableName: string): LogicalPlan => ({
      ...mockLogicalPlan_scan_result,
      operators: mockLogicalPlan_scan_result.operators.map(operator =>
        operator.operatorID === mockScanPredicate.operatorID ? { tableName, ...operator } : operator
      ),
    });

    /** How the Dashboard answers a change to the scan: the change compiled, text that only the unit reads. */
    const COMPILED = { operatorId: "1", update: '{"operatorId":"1","layer":"main"}' };

    /**
     * Checks that the change to the scan, its table set to `tableName`, is posted for execution `eid` with
     * `workflow`, and has the Dashboard answer it compiled.
     */
    const expectSentWith = (workflow: LogicalPlan, tableName: string, eid: number = 345): void => {
      const update = httpMock.expectOne(`${EXECUTIONS_URL}/${eid}/updates`);
      expect(update.request.body).toEqual({ operator: scanChangedTo(tableName), workflow });
      update.flush(COMPILED, { status: 201, statusText: "Created" });
    };

    beforeEach(() => {
      // The workflow every execution here runs: a scan, and the result view it feeds.
      TestBed.inject(WorkflowActionService).addOperatorsAndLinks(
        [
          { op: mockScanPredicate, pos: mockPoint },
          { op: mockResultPredicate, pos: mockPoint },
        ],
        [mockScanResultLink]
      );
    });

    /** Starts execution 345, which the unit then reports as paused; the user unlocks the scan and changes its table. */
    const pauseThenChangeScan = (): void => {
      startExecution(345);
      unitReports(ExecutionState.Running, 345);
      unitReports(ExecutionState.Paused, 345);
      unlock();
      editScan("orders");
    };

    it("requires a paused state", fakeAsync(() => {
      startExecution(345);
      unitReports(ExecutionState.Running, 345);

      expect(() => service.modifyOperatorLogic("1")).toThrowError(
        "cannot modify logic, the current execution state is Running"
      );
      httpMock.expectNone(UPDATES_URL);
    }));

    it("has the Dashboard compile the change against the workflow as it was unlocked, then hands it to the unit", fakeAsync(() => {
      pauseThenChangeScan();
      const wsSendSpy = spyOnSocket();

      service.modifyOperatorLogic("1");

      const update = httpMock.expectOne(UPDATES_URL);
      expect(update.request.method).toBe("POST");
      // The scan as the editor holds it once changed, and the whole workflow as the execution ran it, the scan as
      // it was before the change.
      expect(update.request.body).toEqual({ operator: scanChangedTo("orders"), workflow: mockLogicalPlan_scan_result });
      // The unit hears of the change only once the Dashboard has compiled it.
      expect(wsSendSpy).not.toHaveBeenCalled();

      update.flush(COMPILED, { status: 201, statusText: "Created" });

      // The change as the Dashboard answered it, text the page does not read.
      expect(wsSendSpy.mock.calls).toEqual([["OperatorUpdateRequest", { update: COMPILED.update }]]);
    }));

    // One `it` per answer: it.each does not run its body in the zone fakeAsync needs.
    const refusals: { status: number; statusText: string; message: string }[] = [
      {
        status: 400,
        statusText: "Bad Request",
        message: "Limit refers to loop variables, so it can't be changed while the workflow runs.",
      },
      {
        status: 403,
        statusText: "Forbidden",
        message: "Only the user who created execution 345 may change its operators.",
      },
      { status: 409, statusText: "Conflict", message: "Execution 345 has ended." },
      {
        status: 500,
        statusText: "Server Error",
        message: "There was an error processing your request. It has been logged (ID 5f2c1a9be0d34c77).",
      },
    ];
    for (const { status, statusText, message } of refusals) {
      it(`reports a change the Dashboard answers ${status}, and sends the unit nothing`, fakeAsync(() => {
        pauseThenChangeScan();
        const wsSendSpy = spyOnSocket();
        const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

        service.modifyOperatorLogic("1");
        httpMock.expectOne(UPDATES_URL).flush({ code: status, message }, { status, statusText });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(message);
        expect(wsSendSpy).not.toHaveBeenCalled();
        // The run stays paused, for another change or a resume.
        expect(service.getExecutionState().state).toBe(ExecutionState.Paused);
      }));
    }

    it("sends every change of one pause with the workflow as it was first unlocked", fakeAsync(() => {
      pauseThenChangeScan();
      service.modifyOperatorLogic("1");
      expectSentWith(mockLogicalPlan_scan_result, "orders");
      // The scan is unlocked again and changed again: the editor holds the first change by now.
      unlock();
      editScan("returns");
      const wsSendSpy = spyOnSocket();

      service.modifyOperatorLogic("1");

      expectSentWith(mockLogicalPlan_scan_result, "returns");
      expect(wsSendSpy.mock.calls).toEqual([["OperatorUpdateRequest", { update: COMPILED.update }]]);
    }));

    it("sends nothing for a change made without unlocking, and says why", fakeAsync(() => {
      startExecution(345);
      unitReports(ExecutionState.Running, 345);
      unitReports(ExecutionState.Paused, 345);
      editScan("orders");
      const wsSendSpy = spyOnSocket();
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.modifyOperatorLogic("1");

      httpMock.expectNone(UPDATES_URL);
      expect(errorSpy.mock.calls).toEqual([[NOT_SENT]]);
      expect(wsSendSpy).not.toHaveBeenCalled();
      // The run stays paused, for a change once unlocked, or a resume.
      expect(service.getExecutionState().state).toBe(ExecutionState.Paused);
    }));

    it("takes no workflow while the run is not paused", fakeAsync(() => {
      startExecution(345);
      unitReports(ExecutionState.Running, 345);
      unlock();
      unitReports(ExecutionState.Paused, 345);
      editScan("orders");
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.modifyOperatorLogic("1");

      httpMock.expectNone(UPDATES_URL);
      expect(errorSpy.mock.calls).toEqual([[NOT_SENT]]);
    }));

    it("forgets the workflow once the run leaves Paused, and takes it anew at the next unlock", fakeAsync(() => {
      pauseThenChangeScan();
      service.modifyOperatorLogic("1");
      expectSentWith(mockLogicalPlan_scan_result, "orders");
      // The run resumes, with the change, and is paused again.
      unitReports(ExecutionState.Running, 345);
      unitReports(ExecutionState.Paused, 345);
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.modifyOperatorLogic("1");

      httpMock.expectNone(UPDATES_URL);
      expect(errorSpy.mock.calls).toEqual([[NOT_SENT]]);

      // Unlocked in this pause: the workflow as the run has it now, the first change in it.
      unlock();
      editScan("returns");
      service.modifyOperatorLogic("1");

      expectSentWith(workflowWithScanOf("orders"), "returns");
    }));

    it("keeps the workflow while the unit names the same paused execution again", fakeAsync(() => {
      pauseThenChangeScan();
      // What a socket that comes back is told: the state of no run, then the run the unit holds.
      unitReports(ExecutionState.Uninitialized);
      unitReports(ExecutionState.Paused, 345);

      service.modifyOperatorLogic("1");

      expectSentWith(mockLogicalPlan_scan_result, "orders");
    }));

    it("forgets the workflow when the unit names another paused execution", fakeAsync(() => {
      pauseThenChangeScan();
      // Another tab's execution took the unit's place, and is paused too: the run on screen stays paused.
      unitReports(ExecutionState.Paused, 400);
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.modifyOperatorLogic("1");

      expect(service.getExecutionState().state).toBe(ExecutionState.Paused);
      httpMock.expectNone(`${EXECUTIONS_URL}/400/updates`);
      expect(errorSpy.mock.calls).toEqual([[NOT_SENT]]);
    }));

    it("forgets the workflow when another run is asked for", fakeAsync(() => {
      pauseThenChangeScan();
      // A run up to an operator, or a replay, asked for while the run is paused.
      startExecution(346);
      unitReports(ExecutionState.Paused, 346);
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);

      service.modifyOperatorLogic("1");

      httpMock.expectNone(`${EXECUTIONS_URL}/346/updates`);
      expect(errorSpy.mock.calls).toEqual([[NOT_SENT]]);
    }));

    it("sends each change for the execution the unit last named", fakeAsync(() => {
      startExecution(345);
      unitReports(ExecutionState.Running, 345);
      service.killWorkflow();
      unitReports(ExecutionState.Killed, 345);
      startExecution(346);
      unitReports(ExecutionState.Paused, 346);
      unlock();
      editScan("orders");
      const wsSendSpy = spyOnSocket();

      service.modifyOperatorLogic("1");
      expectSentWith(mockLogicalPlan_scan_result, "orders", 346);

      expect(wsSendSpy.mock.calls).toEqual([["OperatorUpdateRequest", { update: COMPILED.update }]]);
    }));

    // The unit names the execution it holds to every session, so a page that did not start the paused run
    // (it was reloaded since, or the run was started in another tab) changes its operators all the same: what its
    // editor holds when an operator is unlocked is the workflow the run ran.
    it("changes a paused run that this page did not start, by the execution the unit names", () => {
      // What a session is told when it opens: the state of no run, then the state of the run the unit holds.
      unitReports(ExecutionState.Uninitialized);
      unitReports(ExecutionState.Paused, 777);
      unlock();
      editScan("orders");
      const wsSendSpy = spyOnSocket();

      service.modifyOperatorLogic("1");
      expectSentWith(mockLogicalPlan_scan_result, "orders", 777);

      expect(wsSendSpy.mock.calls).toEqual([["OperatorUpdateRequest", { update: COMPILED.update }]]);
    });

    it("sends a change for the execution the unit holds, not for the one this page created last", fakeAsync(() => {
      // Another tab's run took the place of this page's on the unit, and paused.
      startExecution(345);
      unitReports(ExecutionState.Running, 345);
      unitReports(ExecutionState.Initializing, 400);
      unitReports(ExecutionState.Paused, 400);
      unlock();
      editScan("orders");
      const wsSendSpy = spyOnSocket();

      service.modifyOperatorLogic("1");
      expectSentWith(mockLogicalPlan_scan_result, "orders", 400);

      expect(wsSendSpy.mock.calls).toEqual([["OperatorUpdateRequest", { update: COMPILED.update }]]);
    }));

    it("refuses to change a paused run whose execution the unit has not named", () => {
      // A state of no run names no execution, and takes the place of the one named before it.
      unitReports(ExecutionState.Paused, 345);
      unitReports(ExecutionState.Uninitialized);
      unitReports(ExecutionState.Paused);
      const wsSendSpy = spyOnSocket();

      expect(() => service.modifyOperatorLogic("1")).toThrowError(
        "cannot modify logic, the computing unit has not named the execution it runs"
      );
      expect(wsSendSpy).not.toHaveBeenCalled();
    });
  });

  // ---- a run the computing unit does not show ---------------------------------------------------

  describe("a run the computing unit does not show", () => {
    const POLL = FOLLOWED_EXECUTION_POLL_INTERVAL_MS;
    const stateUrl = (eid: number): string => `${EXECUTIONS_URL}/${eid}/state`;

    /** The unit reports its run in `state`, of execution `executionId`: of none, the state of no run. */
    const unitReports = (state: ExecutionState, executionId?: number): void =>
      emitWsEvent({ type: "WorkflowStateEvent", state, executionId });

    /** What the Dashboard answers for execution `eid`. */
    const answer = (
      eid: number,
      status: number,
      open: boolean,
      reason: string | null = null,
      timeMs: number = 1794873600123
    ): ExecutionStateResponse => ({ eid, status, open, reason, timeMs });

    /** Lets a poll interval pass, and hands back the question it brings for execution `eid`. */
    const nextQuestion = (eid: number): TestRequest => {
      tick(POLL);
      return httpMock.expectOne(stateUrl(eid));
    };

    /** Lets `ms` pass, in which the Dashboard is asked nothing. */
    const expectNoQuestion = (ms: number = 3 * POLL): void => {
      tick(ms);
      httpMock.expectNone(request => request.url.endsWith("/state"));
    };

    /** The states the page showed, from here on. */
    const statesShown = (): ExecutionState[] => {
      const states: ExecutionState[] = [];
      service.getExecutionStateStream().subscribe(event => states.push(event.current.state));
      return states;
    };

    /** The unit runs execution `eid`, and then its socket drops. */
    const loseSocketDuringRun = (eid: number): void => {
      unitReports(ExecutionState.Running, eid);
      connected$.next(false);
    };

    beforeEach(() => {
      // The unit stays selected, and in the list as Running: nothing but its socket says that it is gone.
      selectedUnit$.next({
        computingUnit: { cuid: CUID },
        status: "Running",
      } as unknown as DashboardWorkflowComputingUnit);
    });

    it("asks the Dashboard for the execution's state every 5 s while the socket is down during a run", fakeAsync(() => {
      loseSocketDuringRun(345);

      // Not at once: a socket that only dropped redials within the interval, and its unit names the run again.
      tick(POLL - 1);
      httpMock.expectNone(stateUrl(345));
      tick(1);
      const first = httpMock.expectOne(stateUrl(345));
      expect(first.request.method).toBe("GET");
      first.flush(answer(345, 1, true));

      tick(POLL - 1);
      httpMock.expectNone(stateUrl(345));
      tick(1);
      httpMock.expectOne(stateUrl(345)).flush(answer(345, 1, true));
      nextQuestion(345).flush(answer(345, 1, true));

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      service.resetExecutionAndWorkers();
    }));

    it("shows the status an open execution is answered with, as the history reads it", fakeAsync(() => {
      loseSocketDuringRun(345);
      const states = statesShown();

      nextQuestion(345).flush(answer(345, 2, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Paused, currentTuples: {} });
      nextQuestion(345).flush(answer(345, 0, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      nextQuestion(345).flush(answer(345, 1, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });

      expect(states).toEqual([ExecutionState.Paused, ExecutionState.Initializing, ExecutionState.Running]);
      // The run is still one the editor is locked for.
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(false);
      service.resetExecutionAndWorkers();
    }));

    it("keeps the tuples a paused run stopped at when it is answered as paused again", fakeAsync(() => {
      unitReports(ExecutionState.Paused, 345);
      emitWsEvent({ type: "OperatorCurrentTuplesUpdateEvent", operatorID: "op1", tuples: [] });
      const paused = service.getExecutionState();
      connected$.next(false);
      const states = statesShown();

      nextQuestion(345).flush(answer(345, 2, true));

      expect(service.getExecutionState()).toBe(paused);
      expect(states).toEqual([]);
      service.resetExecutionAndWorkers();
    }));

    // Not states of a run: no unit has started the execution, or what is stored of it could not be read.
    for (const [what, status] of [
      ["created and started by no unit", 6],
      ["of a state that could not be read", -1],
      ["in a state this page does not know", 42],
    ] as const) {
      it(`leaves the state on screen for an open execution that is ${what}, and asks again`, fakeAsync(() => {
        loseSocketDuringRun(345);
        const states = statesShown();

        nextQuestion(345).flush(answer(345, status, true));

        expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
        expect(states).toEqual([]);
        nextQuestion(345).flush(answer(345, 1, true));
        service.resetExecutionAndWorkers();
      }));
    }

    it("fails the run with the reason a closed execution is answered with, and asks no more", fakeAsync(() => {
      loseSocketDuringRun(345);
      const states = statesShown();
      nextQuestion(345).flush(answer(345, 1, true));

      nextQuestion(345).flush(answer(345, 4, false, "unit lost", 1794873600123));

      // The reason is the run's one error, of no operator, at the time the execution ended.
      expect(service.getExecutionState()).toEqual({
        state: ExecutionState.Failed,
        errorMessages: [
          {
            type: { name: "EXECUTION_FAILURE" },
            timestamp: { seconds: 1794873600, nanos: 123_000_000 },
            message: "unit lost",
            details: "",
            operatorId: "",
            workerId: "",
          },
        ],
      });
      expect(states).toEqual([ExecutionState.Failed]);
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
      expect(service.isFollowingAtDashboard()).toBe(false);
      expectNoQuestion();
    }));

    it("fails the run with no error when a closed execution is answered with no reason", fakeAsync(() => {
      loseSocketDuringRun(345);

      nextQuestion(345).flush({ eid: 345, status: 4, open: false, timeMs: 1794873600000 });

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Failed, errorMessages: [] });
      expectNoQuestion();
    }));

    for (const [status, state] of [
      [3, ExecutionState.Completed],
      [5, ExecutionState.Killed],
    ] as const) {
      it(`shows a closed execution that is ${state} as that, and asks no more`, fakeAsync(() => {
        loseSocketDuringRun(345);

        nextQuestion(345).flush(answer(345, status, false));

        expect(service.getExecutionState()).toEqual({ state });
        expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(true);
        expectNoQuestion();
      }));
    }

    // A closed execution has ended: an answer that calls it anything else must not leave the run going for good.
    for (const status of [1, 6, -1]) {
      it(`fails the run for a closed execution answered with status ${status}, and asks no more`, fakeAsync(() => {
        loseSocketDuringRun(345);

        nextQuestion(345).flush(answer(345, status, false, "unit terminated"));

        expect(service.getExecutionState().state).toBe(ExecutionState.Failed);
        expect(service.getErrorMessages().map(error => error.message)).toEqual(["unit terminated"]);
        expectNoQuestion();
      }));
    }

    // The run ended and the Dashboard has not closed its execution yet: it does within a minute.
    it("shows the ending an open execution is answered with, and asks until the execution is closed", fakeAsync(() => {
      loseSocketDuringRun(345);
      const states = statesShown();

      nextQuestion(345).flush(answer(345, 3, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Completed });
      nextQuestion(345).flush(answer(345, 3, false));

      expect(states).toEqual([ExecutionState.Completed]);
      expectNoQuestion();
    }));

    it("stops the run clock when the Dashboard says how the run ended", fakeAsync(() => {
      unitReports(ExecutionState.Running, 345);
      emitWsEvent({ type: "ExecutionDurationUpdateEvent", duration: 0, isRunning: true });
      connected$.next(false);

      nextQuestion(345).flush(answer(345, 4, false, "unit lost"));
      const atEnd = service.getExecutionDuration();
      tick(60_000);

      expect(atEnd).toBeGreaterThanOrEqual(POLL);
      expect(service.getExecutionDuration()).toBe(atEnd);
    }));

    it("stops asking once the socket is back and its unit names the execution again", fakeAsync(() => {
      loseSocketDuringRun(345);
      nextQuestion(345).flush(answer(345, 1, true));
      const states = statesShown();

      // What a new socket is told: the state of no run, then the state of the run the unit holds.
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);
      unitReports(ExecutionState.Paused, 345);

      // The unit's word is the state on screen again, and what the commands name.
      expect(service.isFollowingAtDashboard()).toBe(false);
      expect(states).toEqual([ExecutionState.Paused]);
      expectNoQuestion();
      const wsSendSpy = spyOnSocket();
      service.resumeWorkflow();
      expect(wsSendSpy.mock.calls).toEqual([["WorkflowResumeRequest", { executionId: 345 }]]);
    }));

    it("drops the answer to a question that is out when the unit names the execution again", fakeAsync(() => {
      loseSocketDuringRun(345);
      const question = nextQuestion(345);

      connected$.next(true);
      unitReports(ExecutionState.Running, 345);

      expect(question.cancelled).toBe(true);
      expectNoQuestion();
    }));

    // A unit that died and restarted answers its socket again, and holds no run.
    it("keeps the state on screen, and keeps asking, when the socket is back and its unit holds no run", fakeAsync(() => {
      loseSocketDuringRun(345);
      const states = statesShown();
      tick(POLL - 1000);

      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      expect(states).toEqual([]);
      expect(TestBed.inject(WorkflowActionService).checkWorkflowModificationEnabled()).toBe(false);
      // The first question still comes 5 s after the unit stopped showing the run, not 5 s after it said so.
      tick(1000);
      httpMock.expectOne(stateUrl(345)).flush(answer(345, 1, true));
      nextQuestion(345).flush(answer(345, 1, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });

      nextQuestion(345).flush(answer(345, 4, false, "unit lost"));

      expect(states).toEqual([ExecutionState.Failed]);
      expect(service.getErrorMessages().map(error => error.message)).toEqual(["unit lost"]);
      expectNoQuestion();
    }));

    it("asks about a run when its unit says, on a socket that stayed up, that it holds none", fakeAsync(() => {
      unitReports(ExecutionState.Running, 345);

      unitReports(ExecutionState.Uninitialized);

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      nextQuestion(345).flush(answer(345, 5, false));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Killed });
    }));

    it("switches to another execution that a state event names", fakeAsync(() => {
      loseSocketDuringRun(345);
      nextQuestion(345).flush(answer(345, 1, true));
      const states = statesShown();

      // Another page's run took the unit while this page's socket was down.
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);
      unitReports(ExecutionState.Paused, 400);

      expect(states).toEqual([ExecutionState.Paused]);
      expectNoQuestion();
      // It is the one asked about from now on.
      connected$.next(false);
      nextQuestion(400).flush(answer(400, 3, false));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Completed });
    }));

    it("stops asking about a run when the user asks for another, which is followed in its place", fakeAsync(() => {
      loseSocketDuringRun(345);
      const question = nextQuestion(345);
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);

      service.executeWorkflow("again");

      expect(question.cancelled).toBe(true);
      expect(service.isFollowingAtDashboard()).toBe(false);
      expectCreate().flush(created(346), { status: 201, statusText: "Created" });
      expectNoQuestion();
      // The unit that is asked to start the run and then loses its socket is asked about that run.
      connected$.next(false);
      nextQuestion(346).flush(answer(346, 4, false, "unit lost"));
      expect(service.getErrorMessages().map(error => error.message)).toEqual(["unit lost"]);
    }));

    it("says that pause, resume and kill have no unit to go to, and sends none, while it asks", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      const following: boolean[] = [];
      service.getFollowingAtDashboardStream().subscribe(isFollowing => following.push(isFollowing));
      unitReports(ExecutionState.Running, 345);
      expect(service.isFollowingAtDashboard()).toBe(false);

      // From the moment the unit stops showing the run, before the Dashboard has answered anything.
      connected$.next(false);
      expect(service.isFollowingAtDashboard()).toBe(true);
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);
      expect(service.isFollowingAtDashboard()).toBe(true);

      const unnamed = "the computing unit has not named the execution it runs";
      expect(() => service.pauseWorkflow()).toThrowError(`cannot pause workflow, ${unnamed}`);
      expect(() => service.killWorkflow()).toThrowError(`cannot kill workflow, ${unnamed}`);
      nextQuestion(345).flush(answer(345, 2, true));
      expect(() => service.resumeWorkflow()).toThrowError(`cannot resume workflow, ${unnamed}`);
      expect(wsSendSpy).not.toHaveBeenCalled();

      nextQuestion(345).flush(answer(345, 4, false, "unit lost"));
      expect(following).toEqual([false, true, false]);
    }));

    // Run is not held back by the run on screen: the unit that is back holds none.
    it("starts another run while it asks about the one on screen", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      loseSocketDuringRun(345);
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);

      expect(service.executeWorkflow("again")).toBe(true);
      expectCreate().flush(created(346), { status: 201, statusText: "Created" });

      expect(wsSendSpy.mock.calls).toEqual([["WorkflowStartRequest", { plan: planOf(346) }]]);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
    }));

    it("asks nothing for a run whose execution no state event named", fakeAsync(() => {
      unitReports(ExecutionState.Running);

      connected$.next(false);
      expectNoQuestion();
      // The state of no run ends it, as it does for a page that follows nothing.
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
      expectNoQuestion();
    }));

    for (const ended of [ExecutionState.Completed, ExecutionState.Killed]) {
      it(`asks nothing for a followed run that the unit reported as ${ended}`, fakeAsync(() => {
        unitReports(ExecutionState.Running, 345);
        unitReports(ended, 345);

        connected$.next(false);
        expectNoQuestion();
        // The state of no run takes the place of a run that has ended.
        connected$.next(true);
        unitReports(ExecutionState.Uninitialized);

        expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
        expectNoQuestion();
      }));
    }

    it("asks nothing about a run the unit was asked to start, while its socket stays up", fakeAsync(() => {
      startExecution(345);

      expectNoQuestion();

      expect(service.isFollowingAtDashboard()).toBe(false);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
    }));

    it("asks about a run the unit was asked to start, once its socket drops before it reports the run", fakeAsync(() => {
      startExecution(345);

      connected$.next(false);
      // Created, and started by no unit: the run goes on showing as starting.
      nextQuestion(345).flush(answer(345, 6, true));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Initializing });
      nextQuestion(345).flush(answer(345, 4, false, "never started"));

      expect(service.getErrorMessages().map(error => error.message)).toEqual(["never started"]);
      expectNoQuestion();
    }));

    it("stops asking about a run whose start the unit refuses", fakeAsync(() => {
      vi.spyOn(TestBed.inject(NotificationService), "error").mockReturnValue(undefined as never);
      startExecution(345);
      connected$.next(false);
      connected$.next(true);
      unitReports(ExecutionState.Uninitialized);

      emitWsEvent({
        type: "RequestRefusedEvent",
        request: "WorkflowStartRequest",
        executionId: 345,
        message: "Execution 345 could not be claimed for its start. Run the workflow again.",
      });

      expect(service.isFollowingAtDashboard()).toBe(false);
      expectNoQuestion();
      expect(service.getErrorMessages().map(error => error.message)).toEqual([
        "Execution 345 could not be claimed for its start. Run the workflow again.",
      ]);
    }));

    it("asks again after a question the Dashboard does not answer, or answers with an error", fakeAsync(() => {
      loseSocketDuringRun(345);

      nextQuestion(345).error(new ProgressEvent("error"), { status: 0, statusText: "Unknown Error" });
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      nextQuestion(345).flush({ code: 500, message: "no" }, { status: 500, statusText: "Server Error" });
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Running });
      nextQuestion(345).flush(answer(345, 3, false));

      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Completed });
    }));

    it("asks no second question while the one before it is unanswered", fakeAsync(() => {
      loseSocketDuringRun(345);
      const slow = nextQuestion(345);

      expectNoQuestion(2 * POLL);
      slow.flush(answer(345, 1, true));

      nextQuestion(345).flush(answer(345, 3, false));
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Completed });
    }));

    it("asks nothing after the page leaves the workflow", fakeAsync(() => {
      loseSocketDuringRun(345);
      const question = nextQuestion(345);

      service.resetExecutionAndWorkers();

      expect(question.cancelled).toBe(true);
      expect(service.isFollowingAtDashboard()).toBe(false);
      expectNoQuestion();
      // The next session's socket going down is nothing to ask the Dashboard about either.
      connected$.next(true);
      connected$.next(false);
      expectNoQuestion();
    }));
  });

  // ---- leaving the session a run belongs to ----------------------------------------------------

  describe("resetExecutionAndWorkers", () => {
    it("gives up a run that is waiting for the form debounce", fakeAsync(() => {
      service.executeWorkflow("run");

      service.resetExecutionAndWorkers();

      expectNoCreate();
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
    }));

    it("gives up a run whose execution is being created, so it does not start in the next session", fakeAsync(() => {
      const wsSendSpy = spyOnSocket();
      service.executeWorkflow("run");
      const create = expectCreate();

      service.resetExecutionAndWorkers();

      expect(create.cancelled).toBe(true);
      expect(service.getExecutionState()).toEqual({ state: ExecutionState.Uninitialized });
      expect(wsSendSpy).not.toHaveBeenCalled();
    }));

    it("forgets the execution the unit named, which is not the next session's to change", () => {
      emitWsEvent({ type: "WorkflowStateEvent", state: ExecutionState.Paused, executionId: 345 });

      service.resetExecutionAndWorkers();
      // The next session shows a paused run before its unit has said which execution that is.
      emitWsEvent({ type: "OperatorCurrentTuplesUpdateEvent", operatorID: "1", tuples: [] });

      expect(service.getExecutionState().state).toBe(ExecutionState.Paused);
      expect(() => service.modifyOperatorLogic("1")).toThrowError(
        "cannot modify logic, the computing unit has not named the execution it runs"
      );
    });
  });
});
