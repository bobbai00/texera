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

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { By } from "@angular/platform-browser";
import { ComputingUnitSelectionComponent } from "./computing-unit-selection.component";
import { NzButtonModule } from "ng-zorro-antd/button";
import { CommonModule } from "@angular/common";
import { NzIconModule } from "ng-zorro-antd/icon";
import { ActivatedRoute, ActivatedRouteSnapshot, convertToParamMap, Data, Params, UrlSegment } from "@angular/router";
import { NzDropDownModule } from "ng-zorro-antd/dropdown";
import { NzModalModule, NzModalService } from "ng-zorro-antd/modal";
import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { WorkflowComputingUnitManagingService } from "../../../common/service/computing-unit/workflow-computing-unit/workflow-computing-unit-managing.service";
import { MockComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/mock-computing-unit-status.service";
import { commonTestProviders } from "../../../common/testing/test-utils";
import { UserService } from "../../../common/service/user/user.service";
import { StubUserService } from "../../../common/service/user/stub-user.service";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { Subject, of, throwError } from "rxjs";
import {
  DashboardWorkflowComputingUnit,
  WorkflowComputingUnitType,
} from "../../../common/type/workflow-computing-unit";
import { ComputingUnitCreateModalComponent } from "../../../common/component/computing-unit-create-modal/computing-unit-create-modal.component";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { DEFAULT_WORKFLOW, WorkflowActionService } from "../../service/workflow-graph/model/workflow-action.service";
import { WorkflowExecutionsService } from "../../../dashboard/service/user/workflow-executions/workflow-executions.service";
import { ExecuteWorkflowService } from "../../service/execute-workflow/execute-workflow.service";
import { WorkflowExecutionsEntry } from "../../../dashboard/type/workflow-executions-entry";
import { WorkflowMetadata } from "../../../dashboard/type/workflow-metadata.interface";
import { ExecutionState } from "../../types/execute-workflow.interface";
import { ComputingUnitActionsService } from "../../../common/service/computing-unit/computing-unit-actions/computing-unit-actions.service";
import { ComputingUnitMetadataComponent } from "../../../common/util/computing-unit.util";
import { GuiConfigService } from "../../../common/service/gui-config.service";
import { NzPopoverDirective } from "ng-zorro-antd/popover";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { WarehouseService } from "../../../common/service/warehouse/warehouse.service";
import { WarehouseActionsService } from "../../../common/service/warehouse/warehouse-actions.service";
import { DashboardWarehouse } from "../../../common/type/warehouse";

/**
 * Builds a fully-populated DashboardWorkflowComputingUnit for driving the
 * status/selection code paths. `status` is widened to string so tests can pin
 * runtime-only states (e.g. "Terminating", "Failed") the template branches on.
 */
function makeComputingUnit(
  overrides: Partial<{
    cuid: number;
    name: string;
    uri: string;
    type: WorkflowComputingUnitType;
    status: string;
    statusReason: string;
    isOwner: boolean;
    accessPrivilege: "READ" | "WRITE" | "NONE";
  }> = {}
): DashboardWorkflowComputingUnit {
  const {
    cuid = 1,
    name = "unit",
    uri = `uri-${cuid}`,
    type = "kubernetes",
    status = "Running",
    statusReason,
    isOwner = true,
    accessPrivilege = "WRITE",
  } = overrides;
  return {
    computingUnit: {
      cuid,
      uid: 1,
      name,
      creationTime: 0,
      terminateTime: undefined,
      type,
      uri,
      resource: {
        cpuLimit: "1",
        memoryLimit: "1Gi",
        gpuLimit: "0",
        jvmMemorySize: "1Gi",
        shmSize: "64Mi",
        nodeAddresses: [],
      },
    },
    status: status as DashboardWorkflowComputingUnit["status"],
    statusReason,
    metrics: { cpuUsage: "N/A", memoryUsage: "N/A" },
    isOwner,
    accessPrivilege,
    ownerAvatar: "",
    ownerName: "owner",
  };
}

describe("PowerButtonComponent", () => {
  let component: ComputingUnitSelectionComponent;
  let fixture: ComponentFixture<ComputingUnitSelectionComponent>;

  let activatedRouteMock: Partial<ActivatedRoute>;
  const activatedRouteSnapshotMock: Partial<ActivatedRouteSnapshot> = {
    queryParams: {},
    url: [] as UrlSegment[],
    params: {} as Params,
    fragment: null,
    data: {} as Data,
    paramMap: convertToParamMap({}),
    queryParamMap: convertToParamMap({}),
    outlet: "",
    routeConfig: null,
    root: null as any,
    parent: null as any,
    firstChild: null as any,
    children: [],
    pathFromRoot: [],
  };
  activatedRouteMock = {
    snapshot: activatedRouteSnapshotMock as ActivatedRouteSnapshot,
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        ComputingUnitSelectionComponent,
        HttpClientTestingModule, // Use TestingModule instead of HttpClientModule
        CommonModule,
        NzButtonModule,
        NzIconModule,
        NzDropDownModule,
        NzModalModule, // Add NzModalModule for the NzModalService
        NoopAnimationsModule, // disable animations so overlay/modal content renders synchronously
      ],
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteMock },
        { provide: ComputingUnitStatusService, useClass: MockComputingUnitStatusService },
        { provide: UserService, useClass: StubUserService },
        NzModalService, // Add NzModalService provider
        ...commonTestProviders,
      ],
    }).compileComponents();

    // Selecting a unit now remembers it per workflow in localStorage, which survives
    // between tests and would let one spec's selection steer another's auto-select.
    Object.keys(localStorage)
      .filter(key => key.startsWith("computing-unit-of-workflow-"))
      .forEach(key => localStorage.removeItem(key));

    fixture = TestBed.createComponent(ComputingUnitSelectionComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  describe("showAddComputeUnitModalVisible", () => {
    it("forwards the seeded default name to the embedded create modal", () => {
      fixture.detectChanges();
      component.showAddComputeUnitModalVisible("wf's Computing Unit");
      const modal = fixture.debugElement.query(By.directive(ComputingUnitCreateModalComponent)).componentInstance;
      expect(modal.newComputingUnitName).toBe("wf's Computing Unit");
      expect(component.addComputeUnitModalVisible).toBe(true);
    });

    it("opens the modal without touching the name when no default is given", () => {
      fixture.detectChanges();
      const modal = fixture.debugElement.query(By.directive(ComputingUnitCreateModalComponent)).componentInstance;
      const nameBefore = modal.newComputingUnitName;
      component.showAddComputeUnitModalVisible();
      expect(component.addComputeUnitModalVisible).toBe(true);
      expect(modal.newComputingUnitName).toBe(nameBefore);
    });

    it("still opens when the embedded modal is not available", () => {
      fixture.detectChanges();
      // simulate the ViewChild not (yet) being resolved
      (component as any).computingUnitCreateModal = undefined;
      component.showAddComputeUnitModalVisible("Seed Name");
      expect(component.addComputeUnitModalVisible).toBe(true);
    });

    it("syncs visibility when the embedded modal closes itself", () => {
      fixture.detectChanges();
      component.showAddComputeUnitModalVisible();
      expect(component.addComputeUnitModalVisible).toBe(true);
      const modal = fixture.debugElement.query(By.directive(ComputingUnitCreateModalComponent)).componentInstance;
      modal.visibleChange.emit(false);
      expect(component.addComputeUnitModalVisible).toBe(false);
    });
  });

  describe("onComputingUnitCreated", () => {
    it("selects the created unit for the current workflow when the modal emits unitCreated", () => {
      fixture.detectChanges();
      component.workflowId = 7;
      const selectSpy = vi.spyOn(component, "selectComputingUnit").mockImplementation(() => {});
      const modal = fixture.debugElement.query(By.directive(ComputingUnitCreateModalComponent)).componentInstance;
      // A new unit is Pending. Pins that the row guard stays out of onPickComputingUnit,
      // which would otherwise stop a new unit from being selected.
      modal.unitCreated.emit({
        computingUnit: { cuid: 42 },
        status: "Pending",
      } as unknown as DashboardWorkflowComputingUnit);
      expect(selectSpy).toHaveBeenCalledWith(7, 42);
    });
  });

  describe("showGpuSelection", () => {
    it("reflects the fetched GPU limit options", () => {
      const managingService = TestBed.inject(WorkflowComputingUnitManagingService);
      vi.spyOn(managingService, "getComputingUnitLimitOptions").mockReturnValue(
        of({ cpuLimitOptions: [], memoryLimitOptions: [], gpuLimitOptions: ["0", "1"] })
      );
      const gpuFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      gpuFixture.detectChanges();
      expect(gpuFixture.componentInstance.showGpuSelection()).toBe(true);
    });

    it("hides the GPU row when the deployment reports no GPU support", () => {
      const managingService = TestBed.inject(WorkflowComputingUnitManagingService);
      vi.spyOn(managingService, "getComputingUnitLimitOptions").mockReturnValue(
        of({ cpuLimitOptions: [], memoryLimitOptions: [], gpuLimitOptions: ["0"] })
      );
      const gpuFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      gpuFixture.detectChanges();
      expect(gpuFixture.componentInstance.showGpuSelection()).toBe(false);
    });

    it("falls back to showing GPU metrics when the limit-options fetch fails", () => {
      const managingService = TestBed.inject(WorkflowComputingUnitManagingService);
      vi.spyOn(managingService, "getComputingUnitLimitOptions").mockReturnValue(throwError(() => new Error("boom")));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failedFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      failedFixture.detectChanges();
      expect(failedFixture.componentInstance.showGpuSelection()).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe("onClickOpenShareAccess", () => {
    it("opens the share dialog for the given computing unit", async () => {
      const openSpy = vi
        .spyOn(TestBed.inject(ComputingUnitActionsService), "openShareAccessModal")
        .mockImplementation(() => {});

      await component.onClickOpenShareAccess(7);

      expect(openSpy).toHaveBeenCalledWith(7, true);
    });
  });

  describe("selected computing unit stream (ngOnInit)", () => {
    // Boots a fresh component whose selected-unit stream is a Subject we drive.
    // Must run before the fresh fixture's first detectChanges so ngOnInit
    // subscribes to our subject rather than the mock's default of(null).
    function bootWithSelectedStream(): { selected$: Subject<DashboardWorkflowComputingUnit | null> } {
      const statusService = TestBed.inject(ComputingUnitStatusService);
      const selected$ = new Subject<DashboardWorkflowComputingUnit | null>();
      vi.spyOn(statusService, "getSelectedComputingUnit").mockReturnValue(selected$.asObservable());
      const freshFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      freshFixture.detectChanges();
      return { selected$ };
    }

    it("disables workflow modification and notifies when there are ongoing executions", () => {
      const actionService = TestBed.inject(WorkflowActionService);
      vi.spyOn(actionService, "getWorkflowMetadata").mockReturnValue({ ...DEFAULT_WORKFLOW, wid: 42 });
      const disableSpy = vi.spyOn(actionService, "disableWorkflowModification").mockImplementation(() => {});
      const enableSpy = vi.spyOn(actionService, "enableWorkflowModification").mockImplementation(() => {});
      const execService = TestBed.inject(WorkflowExecutionsService);
      const retrieveSpy = vi
        .spyOn(execService, "retrieveWorkflowExecutions")
        .mockReturnValue(of([{ eId: 1 }] as unknown as WorkflowExecutionsEntry[]));
      const infoSpy = vi.spyOn(TestBed.inject(NotificationService), "info").mockImplementation(() => {});

      const { selected$ } = bootWithSelectedStream();
      selected$.next(makeComputingUnit({ cuid: 7 }));

      expect(retrieveSpy).toHaveBeenCalledWith(42, [ExecutionState.Running, ExecutionState.Initializing]);
      expect(infoSpy).toHaveBeenCalled();
      expect(disableSpy).toHaveBeenCalledTimes(1);
      expect(enableSpy).not.toHaveBeenCalled();
    });

    // "No execution someone else started" is not "nothing is running here": this query asks only
    // about Running and Initializing, and its answer lands asynchronously, after whatever the page
    // set on arrival. A view handed a session with a run in flight had just been given the lock;
    // enabling outright took it away again, leaving a running workflow editable.
    it("leaves a run already in flight locked, even when the backend reports no executions", () => {
      const actionService = TestBed.inject(WorkflowActionService);
      vi.spyOn(actionService, "getWorkflowMetadata").mockReturnValue({ ...DEFAULT_WORKFLOW, wid: 42 });
      const disableSpy = vi.spyOn(actionService, "disableWorkflowModification").mockImplementation(() => {});
      const enableSpy = vi.spyOn(actionService, "enableWorkflowModification").mockImplementation(() => {});
      vi.spyOn(TestBed.inject(WorkflowExecutionsService), "retrieveWorkflowExecutions").mockReturnValue(
        of([] as WorkflowExecutionsEntry[])
      );
      // This page's own execute service is holding a run, as it would after a hand-over.
      (TestBed.inject(ExecuteWorkflowService) as any).currentState = { state: ExecutionState.Running };

      const { selected$ } = bootWithSelectedStream();
      selected$.next(makeComputingUnit({ cuid: 7 }));

      expect(disableSpy).toHaveBeenCalled();
      expect(enableSpy).not.toHaveBeenCalled();
    });

    it("enables workflow modification when there are no ongoing executions", () => {
      const actionService = TestBed.inject(WorkflowActionService);
      vi.spyOn(actionService, "getWorkflowMetadata").mockReturnValue({ ...DEFAULT_WORKFLOW, wid: 42 });
      const disableSpy = vi.spyOn(actionService, "disableWorkflowModification").mockImplementation(() => {});
      const enableSpy = vi.spyOn(actionService, "enableWorkflowModification").mockImplementation(() => {});
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveWorkflowExecutions").mockReturnValue(of([] as WorkflowExecutionsEntry[]));
      const infoSpy = vi.spyOn(TestBed.inject(NotificationService), "info").mockImplementation(() => {});

      const { selected$ } = bootWithSelectedStream();
      selected$.next(makeComputingUnit({ cuid: 7 }));

      expect(enableSpy).toHaveBeenCalledTimes(1);
      expect(disableSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it("does not re-check executions when the same cuid re-emits (lastSelectedCuid guard)", () => {
      const actionService = TestBed.inject(WorkflowActionService);
      vi.spyOn(actionService, "getWorkflowMetadata").mockReturnValue({ ...DEFAULT_WORKFLOW, wid: 42 });
      vi.spyOn(actionService, "enableWorkflowModification").mockImplementation(() => {});
      const execService = TestBed.inject(WorkflowExecutionsService);
      const retrieveSpy = vi
        .spyOn(execService, "retrieveWorkflowExecutions")
        .mockReturnValue(of([] as WorkflowExecutionsEntry[]));

      const { selected$ } = bootWithSelectedStream();
      selected$.next(makeComputingUnit({ cuid: 9 }));
      selected$.next(makeComputingUnit({ cuid: 9 }));

      expect(retrieveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("registerWorkflowMetadataSubscription (ngOnInit)", () => {
    // Boots a fresh component with a controlled metadata-change stream and a
    // mutable metadata object so we can flip the wid and re-emit at will.
    function bootWithMetaStream(units?: DashboardWorkflowComputingUnit[]): {
      comp: ComputingUnitSelectionComponent;
      emit: (wid: number | undefined) => void;
      fixture: ComponentFixture<ComputingUnitSelectionComponent>;
    } {
      if (units) {
        vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(of(units));
      }
      const actionService = TestBed.inject(WorkflowActionService);
      const meta$ = new Subject<WorkflowMetadata>();
      vi.spyOn(actionService, "workflowMetaDataChanged").mockReturnValue(meta$.asObservable());
      let currentMeta: WorkflowMetadata = { ...DEFAULT_WORKFLOW };
      vi.spyOn(actionService, "getWorkflowMetadata").mockImplementation(() => currentMeta);
      const freshFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      freshFixture.detectChanges();
      const emit = (wid: number | undefined) => {
        currentMeta = { ...DEFAULT_WORKFLOW, wid };
        meta$.next(currentMeta);
      };
      return { comp: freshFixture.componentInstance, emit, fixture: freshFixture };
    }

    it("selects the computing unit from the latest execution when the workflow id changes", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 55, status: "Running" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(comp.workflowId).toBe(100);
      expect(selectSpy).toHaveBeenCalledWith(100, 55);
    });

    it("falls back to the first Running unit when retrieving the latest execution fails", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        throwError(() => new Error("no execution"))
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Pending" }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 2);
    });

    it("does not fetch again when the workflow id is unchanged", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      const latestSpy = vi
        .spyOn(execService, "retrieveLatestWorkflowExecution")
        .mockReturnValue(of({ cuId: 1 } as unknown as WorkflowExecutionsEntry));
      const { emit } = bootWithMetaStream();

      emit(100);
      latestSpy.mockClear();
      emit(100);

      expect(latestSpy).not.toHaveBeenCalled();
    });

    it("does not look up an execution for an unsaved workflow", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      const latestSpy = vi.spyOn(execService, "retrieveLatestWorkflowExecution");
      const { comp, emit } = bootWithMetaStream();

      // The placeholder id an unsaved workflow carries: recorded, but never queried for.
      emit(DEFAULT_WORKFLOW.wid);

      expect(comp.workflowId).toBe(DEFAULT_WORKFLOW.wid);
      expect(latestSpy).not.toHaveBeenCalled();
    });

    it("selects nothing when the fetch fails and no unit is Running", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        throwError(() => new Error("no execution"))
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 1, status: "Pending" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).not.toHaveBeenCalled();
    });

    // The last execution's unit is only selected while it is still in the loaded list.
    it("falls back to a Running unit when the last execution's unit is no longer listed", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Pending" }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 2);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 55);
    });

    // Run is disabled on a unit shared with READ access, so falling back to one would select a unit
    // the user cannot run on.
    it("skips a Running unit the user cannot run on when falling back", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Running", accessPrivilege: "READ", isOwner: false }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 2);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 1);
    });

    it("selects nothing when the only Running unit is shared with READ access", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Running", accessPrivilege: "READ", isOwner: false }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).not.toHaveBeenCalled();
    });

    // Only the fallback is access-filtered; the last execution's unit is selected as is.
    it("still selects the last execution's unit when it is listed with READ access", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 55, status: "Running", accessPrivilege: "READ", isOwner: false }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 55);
    });

    it("selects nothing when the last execution's unit is gone and no unit is Running", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 1, status: "Pending" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("still selects the last execution's unit when it is listed but not Running", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 55, status: "Pending" }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 55);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 2);
    });

    it("decides from the latest execution only once, on the first loaded list", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      units$.next([makeComputingUnit({ cuid: 55, status: "Running" })]);
      units$.next([makeComputingUnit({ cuid: 2, status: "Running" })]);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 55);
    });

    it("waits for the unit list before deciding from the latest execution", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      units$.next([]);

      expect(selectSpy).not.toHaveBeenCalled();

      units$.next([makeComputingUnit({ cuid: 55, status: "Running" })]);

      expect(selectSpy).toHaveBeenCalledWith(100, 55);
    });

    it("still falls back to a Running unit when the list arrives after the failed lookup", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        throwError(() => new Error("no execution"))
      );
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).not.toHaveBeenCalled();

      units$.next([makeComputingUnit({ cuid: 2, status: "Running" })]);

      expect(selectSpy).toHaveBeenCalledWith(100, 2);
    });

    it("drops a latest-execution decision when the list arrives after the workflow changed", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockImplementation((wid: number) =>
        of({ cuId: wid === 100 ? 55 : 9 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      emit(101);
      units$.next([
        makeComputingUnit({ cuid: 55, status: "Running" }),
        makeComputingUnit({ cuid: 9, status: "Running" }),
      ]);

      expect(selectSpy).toHaveBeenCalledWith(101, 9);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 55);
    });

    it("only preselects the warehouse when the unit was already settled by a remembered choice", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55, whId: 3 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 77, status: "Running" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 77);
      expect((comp as any).lastExecutionWhid).toBe(3);
    });

    it("falls back to a Running unit when the latest execution has no unit", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: null } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Pending" }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 2);
    });

    it("falls back to a Running unit when both the remembered and the last execution's unit are gone", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 2, status: "Running" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 2);
      expect(localStorage.getItem("computing-unit-of-workflow-100")).toBeNull();
    });

    it("drops a pending latest-execution decision once the component is destroyed", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit, fixture } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      fixture.destroy();
      units$.next([makeComputingUnit({ cuid: 55, status: "Running" })]);

      expect(selectSpy).not.toHaveBeenCalled();
    });

    it.each(["Pending", "Terminating", "Failed", "Unknown"])("does not fall back to a unit that is %s", status => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 2);
    });

    it("picks the first Running unit in list order when several are Running", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 1, status: "Pending" }),
        makeComputingUnit({ cuid: 2, status: "Running" }),
        makeComputingUnit({ cuid: 3, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(100, 2);
    });

    it("drops a latest-execution answer that arrives after the workflow changed underneath it", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      const late$ = new Subject<WorkflowExecutionsEntry>();
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockImplementation((wid: number) =>
        wid === 100 ? late$ : of({ cuId: 9 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 9, status: "Running" }),
        makeComputingUnit({ cuid: 55, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      emit(101); // decides at once from its own latest execution
      late$.next({ cuId: 55 } as unknown as WorkflowExecutionsEntry);

      expect(selectSpy).toHaveBeenCalledWith(101, 9);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 55);
    });

    it("drops the running-unit fallback when the failed lookup was for a workflow no longer shown", () => {
      const execService = TestBed.inject(WorkflowExecutionsService);
      const late$ = new Subject<WorkflowExecutionsEntry>();
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockImplementation((wid: number) =>
        wid === 100 ? late$ : of({ cuId: 9 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 2, status: "Running" }),
        makeComputingUnit({ cuid: 9, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      emit(101);
      late$.error(new Error("no execution"));

      expect(selectSpy).not.toHaveBeenCalledWith(100, 2);
      expect(selectSpy).toHaveBeenCalledTimes(1); // 101's own decision only
    });

    it("prefers the remembered unit for this workflow over the latest execution", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      const latestSpy = vi
        .spyOn(execService, "retrieveLatestWorkflowExecution")
        .mockReturnValue(of({ cuId: 55 } as unknown as WorkflowExecutionsEntry));
      const { comp, emit } = bootWithMetaStream();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(
        of([makeComputingUnit({ cuid: 77, status: "Running" }), makeComputingUnit({ cuid: 55, status: "Running" })])
      );
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 77);
      // The warehouse preselect (#7817) legitimately reads the latest execution
      // even on this path, so assert the unit choice directly instead of the
      // lookup's absence: the latest execution's unit must not win.
      expect(latestSpy).toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalledWith(100, 55);
    });

    // A remembered unit that has since been terminated must not be chased: the status service
    // would wait for it to appear forever and the fallbacks would never run.
    it("forgets a remembered unit that no longer exists and uses the latest execution", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(
        of([makeComputingUnit({ cuid: 55, status: "Running" })])
      );
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 55);
      expect(localStorage.getItem("computing-unit-of-workflow-100")).toBeNull();
    });

    it("still falls back when forgetting the stale unit throws", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(
        of([makeComputingUnit({ cuid: 55, status: "Running" })])
      );
      // Only the component's one removeItem call throws; the storage keeps working for the
      // afterEach clean-up and the tests that follow.
      const removeSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
        throw new Error("storage unavailable");
      });
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      expect(() => emit(100)).not.toThrow();

      expect(removeSpy).toHaveBeenCalledWith("computing-unit-of-workflow-100");
      expect(selectSpy).toHaveBeenCalledWith(100, 55);
      removeSpy.mockRestore();
    });

    // Deciding on an empty list would throw the choice away before the list has loaded, so the
    // decision waits for the first non-empty list.
    it("waits for the unit list before honouring a remembered unit", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      const latestSpy = vi.spyOn(execService, "retrieveLatestWorkflowExecution");
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      units$.next([]);

      expect(selectSpy).not.toHaveBeenCalled();
      expect(latestSpy).not.toHaveBeenCalled();

      units$.next([makeComputingUnit({ cuid: 77, status: "Running" })]);

      expect(selectSpy).toHaveBeenCalledWith(100, 77);
    });

    it("drops a pending remembered decision once the workflow has changed underneath it", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream();
      const units$ = new Subject<DashboardWorkflowComputingUnit[]>();
      vi.spyOn(TestBed.inject(ComputingUnitStatusService), "getAllComputingUnits").mockReturnValue(units$);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);
      // Workflow 101 has nothing remembered, so it decides from its latest execution once the
      // list is in.
      emit(101);
      units$.next([
        makeComputingUnit({ cuid: 77, status: "Running" }),
        makeComputingUnit({ cuid: 55, status: "Running" }),
      ]);

      expect(selectSpy).toHaveBeenCalledWith(101, 55);
      expect(selectSpy).not.toHaveBeenCalledWith(100, 77);
    });

    it("does not carry a remembered unit across workflows", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "77");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([
        makeComputingUnit({ cuid: 77, status: "Running" }),
        makeComputingUnit({ cuid: 55, status: "Running" }),
      ]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(101);

      expect(selectSpy).toHaveBeenCalledWith(101, 55);
    });

    // Number() is lenient enough to turn several kinds of junk into a "valid" cuid.
    ["0", "-3", "1.5", "", "  "].forEach(stored => {
      it(`ignores a remembered value of ${JSON.stringify(stored)}`, () => {
        localStorage.setItem("computing-unit-of-workflow-100", stored);
        const execService = TestBed.inject(WorkflowExecutionsService);
        vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
          of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
        );
        const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 55, status: "Running" })]);
        const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

        emit(100);

        expect(selectSpy).toHaveBeenCalledWith(100, 55);
      });
    });

    it("ignores a corrupt remembered value", () => {
      localStorage.setItem("computing-unit-of-workflow-100", "not-a-number");
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        of({ cuId: 55 } as unknown as WorkflowExecutionsEntry)
      );
      const { comp, emit } = bootWithMetaStream([makeComputingUnit({ cuid: 55, status: "Running" })]);
      const selectSpy = vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});

      emit(100);

      expect(selectSpy).toHaveBeenCalledWith(100, 55);
    });
  });

  describe("selectComputingUnit guards", () => {
    it("does nothing when the cuid is undefined", () => {
      const selectSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "selectComputingUnit");
      component.selectComputingUnit(5, undefined);
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("does nothing when the wid is the default (unsaved) workflow id", () => {
      const selectSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "selectComputingUnit");
      component.selectComputingUnit(DEFAULT_WORKFLOW.wid, 3);
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("selects for a valid wid/cuid pair", () => {
      const selectSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "selectComputingUnit");
      component.selectComputingUnit(5, 3);
      expect(selectSpy).toHaveBeenCalledWith(5, 3);
    });
  });

  describe("status helpers", () => {
    it("the trigger's tooltip names the picker and the unit, in the warehouse trigger's shape", () => {
      // Asserted through the rendered directive, not just the getter: the
      // user-visible contract is one tooltip on the trigger, so a removed
      // binding or a tooltip reintroduced on the name or badge must fail here.
      component.selectedComputingUnit = makeComputingUnit({
        name: "a-very-long-unit-name-that-truncates",
        status: "Running",
      });
      fixture.detectChanges();

      const trigger = fixture.debugElement.query(By.css(".computing-units-dropdown-button"));
      const tooltip = trigger.injector.get(NzTooltipDirective) as NzTooltipDirective;
      expect(tooltip.title).toBe("Computing Unit: a-very-long-unit-name-that-truncates");
      expect(fixture.debugElement.query(By.css(".unit-name-text[nz-tooltip]"))).toBeNull();
      expect(fixture.debugElement.query(By.css(".computing-units-dropdown-button nz-badge[nz-tooltip]"))).toBeNull();

      // The status is not in it: the badge shows that here, in words in the rows.
      component.selectedComputingUnit = makeComputingUnit({ name: "cu", status: "Pending" });
      fixture.detectChanges();
      expect(tooltip.title).toBe("Computing Unit: cu");

      component.selectedComputingUnit = null;
      fixture.detectChanges();
      expect(tooltip.title).toBe("Computing Unit");
    });

    it("computeStatus maps selection + status onto badge states", () => {
      component.selectedComputingUnit = null;
      // Not "processing": nothing is being processed when nothing is selected,
      // and ant renders that as a pulsing blue dot claiming work (#8587).
      expect(component.computeStatus()).toBe("default");
      component.selectedComputingUnit = makeComputingUnit({ status: "Running" });
      expect(component.computeStatus()).toBe("success");
      component.selectedComputingUnit = makeComputingUnit({ status: "Pending" });
      expect(component.computeStatus()).toBe("warning");
      component.selectedComputingUnit = makeComputingUnit({ status: "Terminating" });
      expect(component.computeStatus()).toBe("warning");
      component.selectedComputingUnit = makeComputingUnit({ status: "Failed" });
      expect(component.computeStatus()).toBe("error");
    });

    it("cannotSelectUnit only allows Running units", () => {
      expect(component.cannotSelectUnit(makeComputingUnit({ status: "Running" }))).toBe(false);
      expect(component.cannotSelectUnit(makeComputingUnit({ status: "Pending" }))).toBe(true);
    });

    it("isSelectedUnit matches on the computing unit uri", () => {
      component.selectedComputingUnit = makeComputingUnit({ cuid: 1, uri: "uri-1" });
      expect(component.isSelectedUnit(makeComputingUnit({ cuid: 1, uri: "uri-1" }))).toBe(true);
      expect(component.isSelectedUnit(makeComputingUnit({ cuid: 2, uri: "uri-2" }))).toBe(false);
    });

    it("isComputingUnitRunning reflects the selected unit status", () => {
      component.selectedComputingUnit = null;
      expect(component.isComputingUnitRunning()).toBe(false);
      component.selectedComputingUnit = makeComputingUnit({ status: "Running" });
      expect(component.isComputingUnitRunning()).toBe(true);
      component.selectedComputingUnit = makeComputingUnit({ status: "Pending" });
      expect(component.isComputingUnitRunning()).toBe(false);
    });
  });

  describe("terminateComputingUnit", () => {
    it("errors and does nothing when the cuid is not a known unit", () => {
      component.allComputingUnits = [];
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockImplementation(() => {});
      const confirmSpy = vi
        .spyOn(TestBed.inject(ComputingUnitActionsService), "confirmAndTerminate")
        .mockImplementation(() => {});

      component.terminateComputingUnit(999);

      expect(errorSpy).toHaveBeenCalledWith("Invalid computing unit.");
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it.each(["kubernetes", "local"] as const)(
      "hands a known %s unit to confirmAndTerminate, and sends nothing itself",
      type => {
        const unit = makeComputingUnit({ cuid: 5, type });
        component.allComputingUnits = [unit];
        component.selectedComputingUnit = unit;
        const confirmSpy = vi
          .spyOn(TestBed.inject(ComputingUnitActionsService), "confirmAndTerminate")
          .mockImplementation(() => {});
        const http = TestBed.inject(HttpTestingController);
        // Set aside what the component asked for when it started.
        http.match(() => true);

        component.terminateComputingUnit(5);

        expect(confirmSpy).toHaveBeenCalledWith(5, unit);
        http.verify();
      }
    );
  });

  describe("startEditingUnitName", () => {
    it("blocks non-owners and leaves the editing state untouched", () => {
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockImplementation(() => {});
      component.editingNameOfUnit = null;

      component.startEditingUnitName(makeComputingUnit({ cuid: 3, isOwner: false }));

      expect(errorSpy).toHaveBeenCalledWith("Only owners can rename computing units");
      expect(component.editingNameOfUnit).toBeNull();
    });

    it("enters the edit state for an owned unit", () => {
      vi.useFakeTimers();
      try {
        component.startEditingUnitName(makeComputingUnit({ cuid: 3, name: "Env", isOwner: true }));
        expect(component.editingNameOfUnit).toBe(3);
        expect(component.editingUnitName).toBe("Env");
        // Flush the deferred focus() setTimeout; the input is not in the main DOM
        // tree here, so the guarded focus call is a no-op.
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }
    });

    it("focuses and selects the rename box once it is in the document", () => {
      vi.useFakeTimers();
      const input = document.createElement("input");
      input.className = "unit-name-edit-input";
      document.body.appendChild(input);
      const focus = vi.spyOn(input, "focus").mockImplementation(() => {});
      const select = vi.spyOn(input, "select").mockImplementation(() => {});
      try {
        component.startEditingUnitName(makeComputingUnit({ cuid: 3, name: "Env", isOwner: true }));

        vi.runAllTimers();

        expect(focus).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledTimes(1);
      } finally {
        input.remove();
        vi.useRealTimers();
      }
    });
  });

  describe("confirmUpdateUnitName", () => {
    it("rejects an invalid (empty) name and cancels editing", () => {
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockImplementation(() => {});
      const renameSpy = vi.spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit");
      component.editingNameOfUnit = 3;
      component.editingUnitName = "old";

      component.confirmUpdateUnitName(3, "   ");

      expect(errorSpy).toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(component.editingNameOfUnit).toBeNull();
      expect(component.editingUnitName).toBe("");
    });

    it("renames, patches local + selected caches, refreshes the list and clears edit state on success", () => {
      const listUnit = makeComputingUnit({ cuid: 3, name: "old" });
      component.allComputingUnits = [listUnit];
      component.selectedComputingUnit = makeComputingUnit({ cuid: 3, name: "old" });
      const renameSpy = vi
        .spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit")
        .mockReturnValue(of({} as Response));
      const refreshSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "refreshComputingUnitList");
      vi.spyOn(TestBed.inject(NotificationService), "success").mockImplementation(() => {});
      component.editingNameOfUnit = 3;

      component.confirmUpdateUnitName(3, "  NewName  ");

      expect(renameSpy).toHaveBeenCalledWith(3, "NewName");
      expect(component.allComputingUnits[0].computingUnit.name).toBe("NewName");
      expect(component.selectedComputingUnit!.computingUnit.name).toBe("NewName");
      expect(refreshSpy).toHaveBeenCalled();
      expect(component.editingNameOfUnit).toBeNull();
      expect(component.editingUnitName).toBe("");
    });

    it("shows a failure toast and still clears the edit state when rename errors", () => {
      component.allComputingUnits = [makeComputingUnit({ cuid: 3, name: "old" })];
      vi.spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit").mockReturnValue(
        throwError(() => new Error("nope"))
      );
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockImplementation(() => {});
      component.editingNameOfUnit = 3;
      component.editingUnitName = "old";

      component.confirmUpdateUnitName(3, "NewName");

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to rename"));
      expect(component.editingNameOfUnit).toBeNull();
      expect(component.editingUnitName).toBe("");
    });

    it("leaves the caches alone when the renamed unit is neither listed nor selected", () => {
      component.allComputingUnits = [makeComputingUnit({ cuid: 9, name: "other" })];
      component.selectedComputingUnit = makeComputingUnit({ cuid: 9, name: "other" });
      vi.spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit").mockReturnValue(
        of({} as Response)
      );
      const refreshSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "refreshComputingUnitList");
      vi.spyOn(TestBed.inject(NotificationService), "success").mockImplementation(() => {});
      component.editingNameOfUnit = 3;

      component.confirmUpdateUnitName(3, "NewName");

      expect(component.allComputingUnits[0].computingUnit.name).toBe("other");
      expect(component.selectedComputingUnit!.computingUnit.name).toBe("other");
      expect(refreshSpy).toHaveBeenCalled();
      expect(component.editingNameOfUnit).toBeNull();
    });
  });

  describe("onDropdownVisibilityChange", () => {
    it("refreshes the computing unit list when the dropdown opens", () => {
      const refreshSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "refreshComputingUnitList");
      component.onDropdownVisibilityChange(true);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the dropdown closes", () => {
      const refreshSpy = vi.spyOn(TestBed.inject(ComputingUnitStatusService), "refreshComputingUnitList");
      component.onDropdownVisibilityChange(false);
      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });

  describe("template rendering", () => {
    // The dropdown-menu rows live inside <nz-dropdown-menu>'s deferred
    // <ng-template>, which ng-zorro only stamps into a CDK overlay on open —
    // that overlay does not attach under jsdom, so the rows are not queryable
    // in the document. Coverage of the menu template still comes from the
    // detectChanges below: Angular instantiates projected content eagerly, so
    // the *ngFor rows and their per-unit bindings run even while parked. The
    // assertions here target the trigger button, which renders in the main DOM.
    it("renders the trigger button with the selected unit's name and a status badge", () => {
      component.allComputingUnits = [
        makeComputingUnit({ cuid: 1, name: "Running Unit", status: "Running", isOwner: true }),
        makeComputingUnit({ cuid: 2, name: "Pending Unit", status: "Pending", isOwner: true }),
      ];
      component.selectedComputingUnit = component.allComputingUnits[0];
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector(".unit-name-text")?.textContent).toContain("Running Unit");
      expect(host.querySelector("nz-badge")).toBeTruthy();
      expect(host.querySelector(".connect-text")).toBeNull();
    });

    it("names the missing resource on the trigger when no unit is selected", () => {
      component.selectedComputingUnit = null;
      component.allComputingUnits = [];
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector(".connect-text")?.textContent).toContain("Computing Unit");
      expect(host.querySelector(".unit-name-text")).toBeNull();
    });
  });

  describe("resource display accessors", () => {
    beforeEach(() => {
      component.selectedComputingUnit = makeComputingUnit();
    });

    it("reads the selected unit's raw resource limits and usage", () => {
      expect(component.getCurrentComputingUnitCpuLimit()).toBe("1");
      expect(component.getCurrentComputingUnitMemoryLimit()).toBe("1Gi");
      expect(component.getCurrentComputingUnitGpuLimit()).toBe("0");
      expect(component.getCurrentComputingUnitJvmMemorySize()).toBe("1Gi");
      expect(component.getCurrentSharedMemorySize()).toBe("64Mi");
      expect(component.getCurrentComputingUnitCpuUsage()).toBe("N/A");
      expect(component.getCurrentComputingUnitMemoryUsage()).toBe("N/A");
    });

    it("returns 'NaN' for every accessor when no unit is selected", () => {
      component.selectedComputingUnit = null;
      expect(component.getCurrentComputingUnitCpuLimit()).toBe("NaN");
      expect(component.getCurrentComputingUnitMemoryLimit()).toBe("NaN");
      expect(component.getCurrentComputingUnitGpuLimit()).toBe("NaN");
      expect(component.getCurrentComputingUnitJvmMemorySize()).toBe("NaN");
      expect(component.getCurrentSharedMemorySize()).toBe("NaN");
      expect(component.getCurrentComputingUnitCpuUsage()).toBe("NaN");
      expect(component.getCurrentComputingUnitMemoryUsage()).toBe("NaN");
    });
  });

  describe("resource display getters", () => {
    beforeEach(() => {
      component.selectedComputingUnit = makeComputingUnit();
    });

    it("derives the display limits and units from the raw values", () => {
      expect(component.getCpuLimit()).toBe(1);
      expect(component.getMemoryLimit()).toBe(1);
      expect(component.getGpuLimit()).toBe("0");
      expect(component.getJvmMemorySize()).toBe("1Gi");
      expect(component.getSharedMemorySize()).toBe("64Mi");
      expect(component.getCpuLimitUnit()).toBe("CPU");
      expect(component.getMemoryLimitUnit()).toBe("Gi");
    });

    it("returns zero usage values and percentages when metrics are unavailable", () => {
      expect(component.getCpuValue()).toBe(0);
      expect(component.getMemoryValue()).toBe(0);
      expect(component.getCpuPercentage()).toBe(0);
      expect(component.getMemoryPercentage()).toBe(0);
    });

    it("maps a zero percentage to the 'success' progress status", () => {
      expect(component.getCpuStatus()).toBe("success");
      expect(component.getMemoryStatus()).toBe("success");
    });

    it("maps a status to a badge color", () => {
      expect(component.getBadgeColor("Running")).toBe("green");
      expect(component.getBadgeColor("Pending")).toBe("gold");
      expect(component.getBadgeColor("Terminating")).toBe("gold");
      expect(component.getBadgeColor("Failed")).toBe("red");
      expect(component.getBadgeColor("Unknown")).toBe("red");
    });
  });

  describe("trackBy helpers", () => {
    it("trackByCuid keys a unit by its cuid", () => {
      expect(component.trackByCuid(0, makeComputingUnit({ cuid: 77 }))).toBe(77);
    });
  });

  describe("cancelEditingUnitName", () => {
    it("clears the editing state", () => {
      component.editingNameOfUnit = 3;
      component.editingUnitName = "half-typed";
      component.cancelEditingUnitName();
      expect(component.editingNameOfUnit).toBeNull();
      expect(component.editingUnitName).toBe("");
    });
  });

  describe("openComputingUnitMetadataModal", () => {
    it("opens the metadata modal with the unit as nzData", () => {
      const unit = makeComputingUnit({ cuid: 9 });
      const createSpy = vi.spyOn(TestBed.inject(NzModalService), "create").mockReturnValue({} as any);
      try {
        component.openComputingUnitMetadataModal(unit);

        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            nzTitle: "Computing Unit Information",
            nzContent: ComputingUnitMetadataComponent,
            nzData: unit,
            nzFooter: null,
          })
        );
      } finally {
        createSpy.mockRestore();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Rows of the dropdown menu, driven through the markup ng-zorro stamps into
  // the CDK overlay rather than by calling the handlers on the instance.
  // ──────────────────────────────────────────────────────────────────────────
  describe("dropdown menu rows (rendered)", () => {
    /**
     * ng-zorro gates the dropdown's overlay behind an `auditTime(150)` that it
     * schedules outside the Angular zone, so neither `fakeAsync`'s `tick()` nor
     * Vitest's fake timers reach it — zone.js captured the native timer before
     * either could patch it. Poll for the rows instead of sleeping a fixed
     * amount, so a slow runner costs extra iterations rather than a failure.
     */
    async function openDropdown(): Promise<HTMLElement[]> {
      fixture.debugElement.query(By.css(".computing-units-dropdown-button")).nativeElement.click();
      for (let i = 0; i < 80 && document.querySelectorAll(".computing-unit-option").length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        fixture.detectChanges();
      }
      fixture.detectChanges();
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".computing-unit-option"));
      expect(rows.length).toBeGreaterThan(0);
      return rows;
    }

    function click(element: Element | null | undefined): void {
      expect(element).toBeTruthy();
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      fixture.detectChanges();
    }

    let selectSpy: ReturnType<typeof vi.spyOn>;
    let sharingDefault: boolean;

    beforeEach(() => {
      sharingDefault = TestBed.inject(GuiConfigService).env.sharingComputingUnitEnabled;
      component.workflowId = 5;
      component.allComputingUnits = [
        makeComputingUnit({ cuid: 1, name: "Alpha" }),
        makeComputingUnit({ cuid: 2, name: "Beta" }),
      ];
      selectSpy = vi
        .spyOn(TestBed.inject(ComputingUnitStatusService), "selectComputingUnit")
        .mockImplementation(() => {});
      fixture.detectChanges();
    });

    afterEach(() => {
      // The share test flips this flag. TestBed hands every test its own
      // MockGuiConfigService, so it cannot leak today, but restore it anyway so the
      // block stays correct if these tests ever share one config instance.
      TestBed.inject(GuiConfigService).env.sharingComputingUnitEnabled = sharingDefault;
      // Clear the overlay contents rather than the container itself, which CDK caches.
      document.querySelectorAll(".cdk-overlay-container").forEach(el => (el.innerHTML = ""));
      vi.restoreAllMocks();
    });

    it("selects the unit whose row is clicked", async () => {
      const rows = await openDropdown();

      click(rows[1]);

      expect(component.selectedComputingUnit?.computingUnit.cuid).toBe(2);
      expect(selectSpy).toHaveBeenCalledWith(5, 2);
    });

    it.each(["Failed", "Unknown", "Terminating", "Pending"] as const)(
      "ignores a click on a %s row, which nz-menu only greys out",
      async status => {
        // nzDisabled does not stop the (click) on the same <li>, so our own guard must.
        component.allComputingUnits = [
          makeComputingUnit({ cuid: 1, name: "Alpha" }),
          makeComputingUnit({ cuid: 2, name: "Beta", status }),
        ];
        fixture.detectChanges();
        // Spy on the only writer of the key, so the check holds even where Storage is unusable.
        const rememberSpy = vi.spyOn(component as any, "rememberComputingUnit");
        const rows = await openDropdown();

        click(rows[1]);

        expect(component.selectedComputingUnit).toBeNull();
        expect(selectSpy).not.toHaveBeenCalled();
        expect(rememberSpy).not.toHaveBeenCalled();
        expect(Object.keys(localStorage)).not.toContain("computing-unit-of-workflow-5");
      }
    );

    it("still selects a Running row, and remembers it", async () => {
      const rememberSpy = vi.spyOn(component as any, "rememberComputingUnit");
      const rows = await openDropdown();

      click(rows[0]);

      expect(component.selectedComputingUnit?.computingUnit.cuid).toBe(1);
      expect(selectSpy).toHaveBeenCalledWith(5, 1);
      expect(rememberSpy).toHaveBeenCalledWith(5, 1);
    });

    it("commits a rename when the inline editor loses focus", async () => {
      const renameSpy = vi
        .spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit")
        .mockReturnValue(of({} as any));
      component.editingNameOfUnit = 1;
      component.editingUnitName = "Alpha";
      const rows = await openDropdown();

      const editor = rows[0].querySelector<HTMLInputElement>(".unit-name-edit-input");
      expect(editor?.value).toBe("Alpha");
      editor!.value = "Renamed";
      editor!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      fixture.detectChanges();

      expect(renameSpy).toHaveBeenCalledWith(1, "Renamed");
    });

    it("commits a rename when Enter is pressed in the inline editor", async () => {
      const renameSpy = vi
        .spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit")
        .mockReturnValue(of({} as any));
      component.editingNameOfUnit = 1;
      component.editingUnitName = "Alpha";
      const rows = await openDropdown();

      const editor = rows[0].querySelector<HTMLInputElement>(".unit-name-edit-input");
      editor!.value = "Entered";
      editor!.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      fixture.detectChanges();

      expect(renameSpy).toHaveBeenCalledWith(1, "Entered");
    });

    it("abandons the rename when Escape is pressed in the inline editor", async () => {
      const renameSpy = vi.spyOn(TestBed.inject(WorkflowComputingUnitManagingService), "renameComputingUnit");
      component.editingNameOfUnit = 1;
      component.editingUnitName = "Alpha";
      const rows = await openDropdown();

      rows[0]
        .querySelector<HTMLInputElement>(".unit-name-edit-input")!
        .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      fixture.detectChanges();

      expect(component.editingNameOfUnit).toBeNull();
      expect(renameSpy).not.toHaveBeenCalled();
    });

    it("swallows a click inside the inline editor instead of selecting the row", async () => {
      component.editingNameOfUnit = 1;
      component.editingUnitName = "Alpha";
      const rows = await openDropdown();

      click(rows[0].querySelector(".unit-name-edit-input"));

      expect(selectSpy).not.toHaveBeenCalled();
      expect(component.editingNameOfUnit).toBe(1);
    });
    it("opens the inline editor from the pencil without selecting the row", async () => {
      const rows = await openDropdown();

      click(rows[0].querySelector(".anticon-edit"));

      expect(component.editingNameOfUnit).toBe(1);
      expect(component.editingUnitName).toBe("Alpha");
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("offers an owner rename, details and terminate on a unit's row, and nothing else", async () => {
      const rows = await openDropdown();

      const actions = Array.from(rows[0].querySelectorAll("i.anticon")).map(icon =>
        Array.from(icon.classList).find(name => name.startsWith("anticon-"))
      );
      expect(actions).toEqual(["anticon-edit", "anticon-eye", "anticon-delete"]);
    });

    it("opens share access from the share icon without selecting the row", async () => {
      TestBed.inject(GuiConfigService).env.sharingComputingUnitEnabled = true;
      const shareSpy = vi
        .spyOn(TestBed.inject(ComputingUnitActionsService), "openShareAccessModal")
        .mockImplementation(() => {});
      fixture.detectChanges();
      const rows = await openDropdown();

      click(rows[0].querySelector(".anticon-share-alt"));

      expect(shareSpy).toHaveBeenCalledWith(1, true);
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("opens the metadata modal from the eye icon without selecting the row", async () => {
      const createSpy = vi.spyOn(TestBed.inject(NzModalService), "create").mockReturnValue({} as any);
      const rows = await openDropdown();

      click(rows[1].querySelector(".anticon-eye"));

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0].nzData).toBe(component.allComputingUnits[1]);
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("terminates from the delete icon without selecting the row", async () => {
      const terminateSpy = vi
        .spyOn(TestBed.inject(ComputingUnitActionsService), "confirmAndTerminate")
        .mockImplementation(() => {});
      const rows = await openDropdown();

      click(rows[0].querySelector(".anticon-delete"));

      expect(terminateSpy).toHaveBeenCalledWith(1, component.allComputingUnits[0]);
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it("opens the create-unit modal from the row below the divider", async () => {
      await openDropdown();

      click(document.querySelector(".create-computing-unit"));

      expect(component.addComputeUnitModalVisible).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // The metrics popover's own template.
  // ──────────────────────────────────────────────────────────────────────────
  describe("metrics popover (rendered)", () => {
    /** A running kubernetes unit whose resource limits the popover reads. */
    function unitWithResources(resource: Partial<Record<string, string>>): DashboardWorkflowComputingUnit {
      const unit = makeComputingUnit({ cuid: 7, name: "Metrics" });
      unit.computingUnit.resource = { ...unit.computingUnit.resource, ...(resource as any) };
      return unit;
    }

    /** Opens the metrics popover and returns the metric names it rendered, in order. */
    async function openMetrics(): Promise<{ names: string[]; overlay: HTMLElement }> {
      const container = fixture.debugElement.query(By.css("#metrics-container-id"));
      expect(container).toBeTruthy();
      container.injector.get(NzPopoverDirective).show();
      fixture.detectChanges();
      // the tooltip base positions its overlay in a microtask
      await Promise.resolve();
      fixture.detectChanges();
      const overlay = document.querySelector<HTMLElement>(".cdk-overlay-container")!;
      const names = Array.from(overlay.querySelectorAll(".resource-metrics .general-metric .metric-name")).map(
        el => el.textContent?.trim() ?? ""
      );
      return { names, overlay };
    }

    afterEach(() => {
      document.querySelectorAll(".cdk-overlay-container").forEach(el => (el.innerHTML = ""));
      vi.restoreAllMocks();
    });

    it("renders the CPU and RAM rows with their value, limit and percentage", async () => {
      component.selectedComputingUnit = unitWithResources({ cpuLimit: "2", memoryLimit: "4Gi" });
      fixture.detectChanges();

      const { names, overlay } = await openMetrics();

      expect(names).toContain("CPU");
      expect(names).toContain("RAM");
      const cpu = overlay.querySelector(".cpu-metric .metric-value")!;
      expect(cpu.querySelector(".metric-unit")?.textContent).toContain("2");
      expect(cpu.querySelector(".metric-percentage")?.textContent).toContain("%");
      const memory = overlay.querySelector(".memory-metric .metric-value")!;
      expect(memory.querySelector(".metric-unit")?.textContent).toContain("4");
      expect(memory.querySelector(".metric-percentage")?.textContent).toContain("%");
    });

    it("adds the GPU, JVM and shared-memory rows when the unit declares those limits", async () => {
      component.gpuOptions = ["0", "1"];
      component.selectedComputingUnit = unitWithResources({
        gpuLimit: "2",
        jvmMemorySize: "1Gi",
        shmSize: "64Mi",
      });
      fixture.detectChanges();

      const { names, overlay } = await openMetrics();

      expect(names).toEqual(["CPU", "RAM", "GPU", "JVM Memory Size", "Shared Memory Size"]);
      expect(overlay.textContent).toContain("2 GPU(s)");
    });

    it("drops the GPU row when the deployment offers no GPU at all", async () => {
      component.gpuOptions = ["0"];
      component.selectedComputingUnit = unitWithResources({ gpuLimit: "2" });
      fixture.detectChanges();

      expect((await openMetrics()).names).not.toContain("GPU");
    });

    it("drops each optional row whose limit reads as zero or NaN", async () => {
      component.gpuOptions = ["0", "1"];
      component.selectedComputingUnit = unitWithResources({
        gpuLimit: "0",
        jvmMemorySize: "NaN",
        shmSize: "0",
      });
      fixture.detectChanges();

      expect((await openMetrics()).names).toEqual(["CPU", "RAM"]);
    });

    it("has no popover content to show while no unit is selected", () => {
      component.selectedComputingUnit = null;
      fixture.detectChanges();

      expect(fixture.debugElement.query(By.css("#metrics-container-id"))).toBeNull();
    });
  });

  describe("remembering the selected unit per workflow", () => {
    const unit77 = { computingUnit: { cuid: 77 } } as unknown as DashboardWorkflowComputingUnit;

    it("writes the user's own pick so the other view of the same workflow restores it", () => {
      component.workflowId = 100;
      const select = vi.spyOn(component, "selectComputingUnit");

      component.onPickComputingUnit(unit77);

      expect(select).toHaveBeenCalledWith(100, 77);
      expect(component.selectedComputingUnit).toBe(unit77);
      expect(localStorage.getItem("computing-unit-of-workflow-100")).toBe("77");
    });

    it("does not remember a unit selected on load, which is derived rather than chosen", () => {
      // The remembered unit, the last execution's or a running one are picked FOR the user; storing
      // them would let a derived unit outrank a fresher last execution on the next load.
      component.selectComputingUnit(100, 77);
      expect(localStorage.getItem("computing-unit-of-workflow-100")).toBeNull();
    });

    it("does not record a pick the component refused to make", () => {
      component.workflowId = DEFAULT_WORKFLOW.wid;
      component.onPickComputingUnit(unit77);
      expect(localStorage.getItem(`computing-unit-of-workflow-${DEFAULT_WORKFLOW.wid}`)).toBeNull();
      component.workflowId = 100;
      component.onPickComputingUnit({ computingUnit: {} } as unknown as DashboardWorkflowComputingUnit);
      expect(localStorage.getItem("computing-unit-of-workflow-100")).toBeNull();
    });

    it("skips remembering when there is no workflow to remember it for", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      (component as any).rememberComputingUnit(undefined, 5);
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });

    it("recalls nothing when storage cannot be read", () => {
      const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage blocked");
      });
      expect((component as any).recallComputingUnit(100)).toBeUndefined();
      getItem.mockRestore();
    });
  });

  describe("warehouse picker (#7817)", () => {
    function makeWarehouse(whid: number, name: string): DashboardWarehouse {
      return {
        whid,
        name,
        lakekeeperWarehouseName: `user-1-${name}`,
        flavor: "local",
        createdAtMillis: 0,
        ownerName: "Alice",
        ownerAvatar: "",
      };
    }

    // Mirrors bootWithMetaStream, additionally pinning the warehouse status and
    // the latest-execution response the preselection logic consumes.
    function bootPicker(opts: {
      enabled: boolean;
      warehouses: DashboardWarehouse[];
      latest?: Partial<WorkflowExecutionsEntry> | "error";
    }): {
      comp: ComputingUnitSelectionComponent;
      pickerFixture: ComponentFixture<ComputingUnitSelectionComponent>;
      emit: (wid: number) => void;
    } {
      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        of({ enabled: opts.enabled, warehouses: opts.warehouses })
      );
      const execService = TestBed.inject(WorkflowExecutionsService);
      if (opts.latest === "error") {
        vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
          throwError(() => new Error("no execution"))
        );
      } else if (opts.latest !== undefined) {
        vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
          of(opts.latest as WorkflowExecutionsEntry)
        );
      }
      const actionService = TestBed.inject(WorkflowActionService);
      const meta$ = new Subject<WorkflowMetadata>();
      vi.spyOn(actionService, "workflowMetaDataChanged").mockReturnValue(meta$.asObservable());
      let currentMeta: WorkflowMetadata = { ...DEFAULT_WORKFLOW };
      vi.spyOn(actionService, "getWorkflowMetadata").mockImplementation(() => currentMeta);
      const pickerFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      pickerFixture.detectChanges();
      const comp = pickerFixture.componentInstance;
      vi.spyOn(comp, "selectComputingUnit").mockImplementation(() => {});
      const emit = (wid: number) => {
        currentMeta = { ...DEFAULT_WORKFLOW, wid };
        meta$.next(currentMeta);
      };
      return { comp, pickerFixture, emit };
    }

    it("preselects the latest execution's warehouse when it still exists", () => {
      const { emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });

      emit(100);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
    });

    it("falls back to the first warehouse when the latest execution used none", () => {
      const { emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: null },
      });

      emit(100);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
    });

    it("still preselects the first warehouse when there is no execution history", () => {
      const { emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first")],
        latest: "error",
      });

      emit(100);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
    });

    it("never picks a warehouse while the feature is disabled, and hides the picker", () => {
      // Warehouses alongside enabled=false cannot come from the real backend; the
      // artificial combination pins that the flag alone suppresses preselection.
      const { pickerFixture, emit } = bootPicker({
        enabled: false,
        warehouses: [makeWarehouse(1, "first")],
        latest: { cuId: 55, whId: 1 },
      });

      emit(100);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBeUndefined();
      expect(pickerFixture.nativeElement.querySelector(".warehouse-dropdown-button")).toBeNull();
    });

    it("a status failure keeps the last known list and pick, and reports the error", () => {
      // A transport failure is not an answer; only an authoritative response
      // (enabled:false, or a list without the pick) may clear the pick.
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });
      emit(100);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
      const errorSpy = vi.spyOn(TestBed.inject(NotificationService), "error").mockImplementation(() => {});
      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        throwError(() => new Error("status unavailable"))
      );

      comp.onWarehouseDropdownVisibilityChange(true);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
      expect(comp.warehouses.map(w => w.whid)).toEqual([1, 2]);
      expect(errorSpy).toHaveBeenCalledWith("Failed to fetch warehouses: status unavailable");
    });

    it("clears any stale pick when the feature is disabled or no warehouse exists", () => {
      TestBed.inject(WarehouseService).selectWarehouse(9);

      const { emit } = bootPicker({ enabled: true, warehouses: [], latest: { cuId: 55, whId: 9 } });
      emit(100);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBeUndefined();
    });

    it("renders the dropdown trigger when enabled, and a manual pick writes through to the service", () => {
      const { comp, pickerFixture } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
      });

      pickerFixture.detectChanges();
      expect(pickerFixture.nativeElement.querySelector(".warehouse-dropdown-button")).toBeTruthy();

      comp.onWarehouseSelected(2);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
      expect(comp.trackByWhid(0, makeWarehouse(2, "second"))).toBe(2);
    });

    it("shows the trigger with the generic label when enabled with zero warehouses", () => {
      const { comp, pickerFixture } = bootPicker({ enabled: true, warehouses: [] });

      pickerFixture.detectChanges();

      expect(pickerFixture.nativeElement.querySelector(".warehouse-dropdown-button")).toBeTruthy();
      expect(comp.getWarehouseButtonText()).toBe("Warehouse");
      expect(comp.warehouseRequiredButMissing).toBe(true);
    });

    it("reports no missing warehouse once the preselect has picked one", () => {
      const { comp } = bootPicker({ enabled: true, warehouses: [makeWarehouse(1, "first")] });

      expect(comp.warehouseRequiredButMissing).toBe(false);
    });

    it("shows the selected warehouse's name on the dropdown trigger", () => {
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });

      emit(100);
      expect(comp.getWarehouseButtonText()).toBe("second");

      // An id that matches no warehouse falls back to the generic label.
      TestBed.inject(WarehouseService).selectWarehouse(999);
      expect(comp.getWarehouseButtonText()).toBe("Warehouse");
    });

    it("refreshes the warehouse list when the dropdown opens, not when it closes", () => {
      const { comp } = bootPicker({ enabled: true, warehouses: [makeWarehouse(1, "first")] });
      const statusSpy = vi.spyOn(TestBed.inject(WarehouseService), "getStatus");
      statusSpy.mockClear();

      comp.onWarehouseDropdownVisibilityChange(true);
      expect(statusSpy).toHaveBeenCalledTimes(1);

      comp.onWarehouseDropdownVisibilityChange(false);
      expect(statusSpy).toHaveBeenCalledTimes(1);
    });

    it("keeps a manual pick across a dropdown-open refresh", () => {
      const { comp } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
      });
      comp.onWarehouseSelected(2);

      comp.onWarehouseDropdownVisibilityChange(true);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
    });

    it("re-preselects when the picked warehouse no longer exists", () => {
      const { comp } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
      });
      comp.onWarehouseSelected(2);
      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        of({ enabled: true, warehouses: [makeWarehouse(1, "first")] })
      );

      comp.onWarehouseDropdownVisibilityChange(true);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
    });

    it("opens the create modal from the menu, and selects a warehouse created there", () => {
      const { comp } = bootPicker({ enabled: true, warehouses: [makeWarehouse(1, "first")] });

      expect(comp.addWarehouseModalVisible).toBe(false);
      comp.showAddWarehouseModalVisible();
      expect(comp.addWarehouseModalVisible).toBe(true);

      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        of({ enabled: true, warehouses: [makeWarehouse(1, "first"), makeWarehouse(9, "fresh")] })
      );
      comp.onWarehouseCreated(makeWarehouse(9, "fresh"));

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(9);
    });

    it("hands the warehouse to the actions service, and re-preselects after the delete", () => {
      const { comp } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
      });
      const actionsService = TestBed.inject(WarehouseActionsService);
      const confirmAndDeleteSpy = vi.spyOn(actionsService, "confirmAndDelete").mockImplementation(() => {});
      const doomed = makeWarehouse(1, "first");

      comp.confirmDeleteWarehouse(doomed);

      expect(confirmAndDeleteSpy).toHaveBeenCalledTimes(1);
      expect(confirmAndDeleteSpy.mock.calls[0][0]).toEqual(doomed);

      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        of({ enabled: true, warehouses: [makeWarehouse(2, "second")] })
      );
      (confirmAndDeleteSpy.mock.calls[0][1] as () => void)();

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
    });

    it("a stale last-execution warehouse never steers the next workflow's fallback", () => {
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });
      emit(100);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);

      // The next workflow has no history: its fallback must be the FIRST
      // warehouse, not the previous workflow's.
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        throwError(() => new Error("no execution"))
      );
      emit(200);

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
    });

    it("a late response from a superseded refresh cannot restore stale state", () => {
      const first = new Subject<{ enabled: boolean; warehouses: DashboardWarehouse[] }>();
      const second = new Subject<{ enabled: boolean; warehouses: DashboardWarehouse[] }>();
      vi.spyOn(TestBed.inject(WarehouseService), "getStatus")
        .mockReturnValueOnce(first.asObservable())
        .mockReturnValueOnce(second.asObservable());
      const execService = TestBed.inject(WorkflowExecutionsService);
      vi.spyOn(execService, "retrieveLatestWorkflowExecution").mockReturnValue(
        throwError(() => new Error("no execution"))
      );
      const pickerFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      pickerFixture.detectChanges();
      const comp = pickerFixture.componentInstance;

      comp.onWarehouseDropdownVisibilityChange(true);
      second.next({ enabled: true, warehouses: [makeWarehouse(2, "kept")] });
      second.complete();
      // The older request settles last; switchMap must already have dropped it.
      first.next({ enabled: true, warehouses: [makeWarehouse(1, "stale"), makeWarehouse(9, "gone")] });
      first.complete();

      expect(comp.warehouses.map(w => w.name)).toEqual(["kept"]);
    });

    it("a status failure keeps the gate closed on an enabled deployment", () => {
      // Failing open would un-gate Run and let the execution write to the
      // shared default storage with no warehouseId.
      TestBed.inject(GuiConfigService).env.warehouseEnabled = true;
      vi.spyOn(TestBed.inject(WarehouseService), "getStatus").mockReturnValue(
        throwError(() => new Error("status unavailable"))
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failedFixture = TestBed.createComponent(ComputingUnitSelectionComponent);
      failedFixture.detectChanges();

      expect(failedFixture.componentInstance.warehouseRequiredButMissing).toBe(true);
      errorSpy.mockRestore();
      TestBed.inject(GuiConfigService).env.warehouseEnabled = false;
    });

    it("a manual pick survives a late latest-execution answer", () => {
      const inFlight = new Subject<WorkflowExecutionsEntry>();
      vi.spyOn(TestBed.inject(WorkflowExecutionsService), "retrieveLatestWorkflowExecution").mockReturnValue(
        inFlight.asObservable()
      );
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
      });
      emit(100);

      comp.onWarehouseSelected(2);
      inFlight.next({ cuId: 55, whId: 1 } as unknown as WorkflowExecutionsEntry);
      inFlight.complete();

      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
    });

    it("switching workflows clears the pick at once, before the new preselect answers", () => {
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });
      emit(100);
      comp.onWarehouseSelected(2);

      // The new workflow's lookup stays pending: in that window nothing of the
      // old workflow's pick may ride an execution.
      const pending = new Subject<WorkflowExecutionsEntry>();
      vi.spyOn(TestBed.inject(WorkflowExecutionsService), "retrieveLatestWorkflowExecution").mockReturnValue(
        pending.asObservable()
      );
      emit(200);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBeUndefined();

      pending.error(new Error("no execution"));
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
    });

    it("deleting the picked warehouse removes it locally and re-preselects, with no refetch", () => {
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first"), makeWarehouse(2, "second")],
        latest: { cuId: 55, whId: 2 },
      });
      emit(100);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(2);
      const statusSpy = vi.spyOn(TestBed.inject(WarehouseService), "getStatus");
      statusSpy.mockClear(); // drop the boot-time call; only the action below counts
      const deleteSpy = vi
        .spyOn(TestBed.inject(WarehouseActionsService), "confirmAndDelete")
        .mockImplementation((_warehouse, onDeleted) => onDeleted());

      comp.confirmDeleteWarehouse(makeWarehouse(2, "second"));

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(comp.warehouses.map(w => w.whid)).toEqual([1]);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(1);
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it("a created warehouse is appended locally and becomes the pick, with no refetch", () => {
      const { comp, emit } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "first")],
        latest: "error",
      });
      emit(100);
      const statusSpy = vi.spyOn(TestBed.inject(WarehouseService), "getStatus");
      statusSpy.mockClear(); // drop the boot-time call; only the action below counts

      comp.onWarehouseCreated(makeWarehouse(9, "fresh"));

      expect(comp.warehouses.map(w => w.whid)).toEqual([1, 9]);
      expect(TestBed.inject(WarehouseService).getSelectedWarehouseIdValue()).toBe(9);
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it("the trigger's tooltip names the picker and the warehouse, whatever the name's length", () => {
      // Two pickers sit side by side showing nothing but a name, and the
      // trigger ellipsises at 220px: one tooltip carries both facts, in the
      // same shape every time, rather than a second one nested on the name.
      const { comp, pickerFixture } = bootPicker({
        enabled: true,
        warehouses: [makeWarehouse(1, "wh"), makeWarehouse(2, "a-very-long-warehouse-name-that-truncates")],
        latest: "error",
      });
      pickerFixture.detectChanges();
      const trigger = pickerFixture.debugElement.query(By.css(".warehouse-dropdown-button"));
      const tooltip = trigger.injector.get(NzTooltipDirective) as NzTooltipDirective;

      comp.onWarehouseSelected(2);
      pickerFixture.detectChanges();
      expect(tooltip.title).toBe("Warehouse: a-very-long-warehouse-name-that-truncates");

      comp.onWarehouseSelected(1);
      pickerFixture.detectChanges();
      expect(tooltip.title).toBe("Warehouse: wh");

      expect(pickerFixture.debugElement.query(By.css(".warehouse-name-text[nz-tooltip]"))).toBeNull();
    });
  });
});
