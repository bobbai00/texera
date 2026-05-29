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
import { of, throwError } from "rxjs";
import { DashboardAgentToolsService } from "./dashboard-agent-tools.service";
import { WorkflowPersistService } from "../../../common/service/workflow-persist/workflow-persist.service";
import { DatasetService } from "../../../dashboard/service/user/dataset/dataset.service";
import { SearchService } from "../../../dashboard/service/user/search.service";
import { DashboardWorkflow } from "../../../dashboard/type/dashboard-workflow.interface";
import { DashboardDataset } from "../../../dashboard/type/dashboard-dataset.interface";
import { DashboardEntry } from "../../../dashboard/type/dashboard-entry";
import { ExecutionMode } from "../../../common/type/workflow";

const TOOL_OPTIONS = { toolCallId: "test-call", messages: [] };

function makeDataset(did: number | undefined, name: string): DashboardDataset {
  return {
    isOwner: true,
    ownerEmail: "owner@texera.io",
    accessPrivilege: "WRITE",
    size: 0,
    dataset: {
      did,
      ownerUid: 1,
      name,
      isPublic: false,
      isDownloadable: true,
      storagePath: undefined,
      description: "a dataset",
      creationTime: undefined,
      coverImage: undefined,
    },
  };
}

function makeWorkflow(wid: number | undefined, name: string): DashboardWorkflow {
  return {
    isOwner: true,
    ownerName: "me",
    projectIDs: [],
    accessLevel: "WRITE",
    ownerId: 1,
    workflow: {
      content: {
        operators: [],
        operatorPositions: {},
        links: [],
        commentBoxes: [],
        settings: { dataTransferBatchSize: 400, executionMode: ExecutionMode.PIPELINED },
      },
      name,
      description: "wf desc",
      wid,
      creationTime: undefined,
      lastModifiedTime: undefined,
      isPublished: 0,
      readonly: false,
    },
  };
}

describe("DashboardAgentToolsService", () => {
  let service: DashboardAgentToolsService;
  let workflowPersistService: {
    retrieveWorkflowsBySessionUser: ReturnType<typeof vi.fn>;
    createWorkflow: ReturnType<typeof vi.fn>;
    updateWorkflowDescription: ReturnType<typeof vi.fn>;
  };
  let datasetService: {
    retrieveAccessibleDatasets: ReturnType<typeof vi.fn>;
    createDataset: ReturnType<typeof vi.fn>;
  };
  let searchService: { executeSearch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workflowPersistService = {
      retrieveWorkflowsBySessionUser: vi.fn(),
      createWorkflow: vi.fn(),
      updateWorkflowDescription: vi.fn().mockReturnValue(of({})),
    };
    datasetService = {
      retrieveAccessibleDatasets: vi.fn(),
      createDataset: vi.fn(),
    };
    searchService = { executeSearch: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        DashboardAgentToolsService,
        { provide: WorkflowPersistService, useValue: workflowPersistService },
        { provide: DatasetService, useValue: datasetService },
        { provide: SearchService, useValue: searchService },
      ],
    });
    service = TestBed.inject(DashboardAgentToolsService);
  });

  // Invokes a tool's `execute` the way the AI SDK does.
  function runTool(name: string, args: unknown): Promise<any> {
    const tool = service.all()[name];
    const execute = tool.execute as (input: unknown, options: unknown) => Promise<any>;
    return execute(args, TOOL_OPTIONS);
  }

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("exposes exactly the five dashboard tools", () => {
    expect(Object.keys(service.all()).sort()).toEqual([
      "createDataset",
      "createWorkflow",
      "listDatasets",
      "listWorkflows",
      "searchResources",
    ]);
  });

  it("listDatasets delegates to DatasetService and attaches dataset links", async () => {
    datasetService.retrieveAccessibleDatasets.mockReturnValue(of([makeDataset(7, "sales")]));

    const result = await runTool("listDatasets", {});

    expect(datasetService.retrieveAccessibleDatasets).toHaveBeenCalledTimes(1);
    expect(result.datasets[0].name).toBe("sales");
    expect(result.datasets[0].link).toBe("/dashboard/user/dataset/7");
  });

  it("listWorkflows delegates to WorkflowPersistService and attaches editor links", async () => {
    workflowPersistService.retrieveWorkflowsBySessionUser.mockReturnValue(of([makeWorkflow(42, "pipeline")]));

    const result = await runTool("listWorkflows", {});

    expect(workflowPersistService.retrieveWorkflowsBySessionUser).toHaveBeenCalledTimes(1);
    expect(result.workflows[0].name).toBe("pipeline");
    expect(result.workflows[0].link).toBe("/dashboard/user/workflow/42");
  });

  it("createWorkflow creates an empty workflow with all five content keys and returns its link", async () => {
    workflowPersistService.createWorkflow.mockReturnValue(of(makeWorkflow(99, "My Workflow")));

    const result = await runTool("createWorkflow", { name: "My Workflow" });

    expect(workflowPersistService.createWorkflow).toHaveBeenCalledTimes(1);
    const [contentArg, nameArg] = workflowPersistService.createWorkflow.mock.calls[0];
    expect(nameArg).toBe("My Workflow");
    expect(Object.keys(contentArg).sort()).toEqual([
      "commentBoxes",
      "links",
      "operatorPositions",
      "operators",
      "settings",
    ]);
    expect(result.id).toBe(99);
    expect(result.link).toBe("/dashboard/user/workflow/99");
  });

  it("createDataset forwards only the supported fields (with defaults) and returns its link", async () => {
    datasetService.createDataset.mockReturnValue(of(makeDataset(5, "New DS")));

    const result = await runTool("createDataset", { name: "New DS", description: "notes", isPublic: true });

    expect(datasetService.createDataset).toHaveBeenCalledTimes(1);
    const datasetArg = datasetService.createDataset.mock.calls[0][0];
    expect(datasetArg.name).toBe("New DS");
    expect(datasetArg.description).toBe("notes");
    expect(datasetArg.isPublic).toBe(true);
    expect(datasetArg.isDownloadable).toBe(true); // default applied
    expect(result.id).toBe(5);
    expect(result.link).toBe("/dashboard/user/dataset/5");
  });

  it("searchResources delegates to SearchService and maps hits to links", async () => {
    const workflowEntry = { type: "workflow", id: 42, name: "pipeline" } as unknown as DashboardEntry;
    searchService.executeSearch.mockReturnValue(of({ entries: [workflowEntry], more: false, hasMismatch: undefined }));

    const result = await runTool("searchResources", { keywords: ["pipe"] });

    expect(searchService.executeSearch).toHaveBeenCalledTimes(1);
    expect(result.hits[0].type).toBe("workflow");
    expect(result.hits[0].link).toBe("/dashboard/user/workflow/42");
  });

  it("returns a structured error (instead of throwing) when a service call fails", async () => {
    datasetService.retrieveAccessibleDatasets.mockReturnValue(throwError(() => new Error("boom")));

    const result = await runTool("listDatasets", {});

    expect(result.error).toContain("boom");
  });
});
