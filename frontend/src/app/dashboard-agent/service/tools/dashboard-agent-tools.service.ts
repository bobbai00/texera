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

import { Injectable } from "@angular/core";
import { tool, ToolSet } from "ai";
import { z } from "zod";
import { firstValueFrom } from "rxjs";
import { HttpErrorResponse } from "@angular/common/http";
import {
  DEFAULT_WORKFLOW_NAME,
  WorkflowPersistService,
} from "../../../common/service/workflow-persist/workflow-persist.service";
import { DatasetService } from "../../../dashboard/service/user/dataset/dataset.service";
import { SearchService } from "../../../dashboard/service/user/search.service";
import { ExecutionMode, WorkflowContent } from "../../../common/type/workflow";
import { Dataset } from "../../../common/type/dataset";
import { DashboardWorkflow } from "../../../dashboard/type/dashboard-workflow.interface";
import { DashboardDataset } from "../../../dashboard/type/dashboard-dataset.interface";
import { SearchFilterParameters } from "../../../dashboard/type/search-filter-parameters";
import { SortMethod } from "../../../dashboard/type/sort-method";
import { DashboardEntry } from "../../../dashboard/type/dashboard-entry";
import { EntityType } from "../../../hub/service/hub.service";
import { DASHBOARD_USER_DATASET, DASHBOARD_USER_WORKSPACE } from "../../../app-routing.constant";
import { AgentDatasetSummary, AgentSearchHit, AgentWorkflowSummary } from "../../type/dashboard-agent.type";

/**
 * Defines the frontend tools available to the Texera Dashboard Agent.
 *
 * Each tool is a thin adapter that delegates to an existing Texera Angular
 * service ({@link WorkflowPersistService}, {@link DatasetService},
 * {@link SearchService}) and shapes the result for the model, always including
 * a direct dashboard route link so the agent can hand the user a clickable
 * destination. The tools deliberately add no new HTTP calls of their own.
 */
@Injectable({
  providedIn: "root",
})
export class DashboardAgentToolsService {
  constructor(
    private workflowPersistService: WorkflowPersistService,
    private datasetService: DatasetService,
    private searchService: SearchService
  ) {}

  /** Returns the complete tool set passed to the AI SDK's `streamText` call. */
  public all(): ToolSet {
    return {
      listDatasets: tool({
        description:
          "List all datasets the current user can access. Returns each dataset's name, description and a direct link.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const datasets = await firstValueFrom(this.datasetService.retrieveAccessibleDatasets());
            return { datasets: datasets.map(d => this.toDatasetSummary(d)) };
          } catch (e) {
            return { error: this.toErrorMessage(e) };
          }
        },
      }),

      listWorkflows: tool({
        description:
          "List all workflows that belong to the current user. Returns each workflow's name and a direct link to open it in the editor.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const workflows = await firstValueFrom(this.workflowPersistService.retrieveWorkflowsBySessionUser());
            return { workflows: workflows.map(w => this.toWorkflowSummary(w)) };
          } catch (e) {
            return { error: this.toErrorMessage(e) };
          }
        },
      }),

      createWorkflow: tool({
        description:
          "Create a new, empty workflow for the current user. Returns the new workflow's id and a direct link to open it in the editor.",
        inputSchema: z.object({
          name: z.string().describe("Name for the new workflow.").optional(),
          description: z.string().describe("Optional description for the new workflow.").optional(),
        }),
        execute: async ({ name, description }) => {
          try {
            const created = await firstValueFrom(
              this.workflowPersistService.createWorkflow(
                this.emptyWorkflowContent(),
                name?.trim() || DEFAULT_WORKFLOW_NAME
              )
            );
            const wid = created.workflow.wid;
            if (description && wid != null) {
              // Best-effort: keep the created workflow even if the description update fails.
              try {
                await firstValueFrom(this.workflowPersistService.updateWorkflowDescription(wid, description));
              } catch {
                /* ignore description update failure */
              }
            }
            return {
              id: wid,
              name: created.workflow.name,
              link: wid != null ? this.workflowLink(wid) : null,
            };
          } catch (e) {
            return { error: this.toErrorMessage(e) };
          }
        },
      }),

      createDataset: tool({
        description: "Create a new dataset for the current user. Returns the new dataset's id and a direct link.",
        inputSchema: z.object({
          name: z.string().describe("Name for the new dataset."),
          description: z.string().describe("Optional description for the new dataset.").optional(),
          isPublic: z.boolean().describe("Whether the dataset is publicly visible. Defaults to false.").optional(),
          isDownloadable: z.boolean().describe("Whether the dataset can be downloaded. Defaults to true.").optional(),
        }),
        execute: async ({ name, description, isPublic, isDownloadable }) => {
          try {
            const dataset: Dataset = {
              did: undefined,
              ownerUid: undefined,
              name,
              isPublic: isPublic ?? false,
              isDownloadable: isDownloadable ?? true,
              storagePath: undefined,
              description: description ?? "",
              creationTime: undefined,
              coverImage: undefined,
            };
            const created = await firstValueFrom(this.datasetService.createDataset(dataset));
            const did = created.dataset.did;
            return {
              id: did,
              name: created.dataset.name,
              link: did != null ? this.datasetLink(did) : null,
            };
          } catch (e) {
            return { error: this.toErrorMessage(e) };
          }
        },
      }),

      searchResources: tool({
        description:
          "Search the user's workflows, datasets and projects by keyword. Returns matching resources with direct links.",
        inputSchema: z.object({
          keywords: z.array(z.string()).describe("One or more search keywords."),
          type: z
            .enum(["workflow", "dataset", "project"])
            .describe("Optionally restrict the search to a single resource type.")
            .optional(),
        }),
        execute: async ({ keywords, type }) => {
          try {
            const batch = await firstValueFrom(
              this.searchService.executeSearch(
                keywords,
                this.emptyFilterParameters(),
                0,
                20,
                type ?? null,
                SortMethod.EditTimeDesc,
                true,
                true
              )
            );
            return { hits: batch.entries.map(e => this.toSearchHit(e)) };
          } catch (e) {
            return { error: this.toErrorMessage(e) };
          }
        },
      }),
    };
  }

  private toDatasetSummary(d: DashboardDataset): AgentDatasetSummary {
    const did = d.dataset.did;
    return {
      did,
      name: d.dataset.name,
      description: d.dataset.description,
      isPublic: d.dataset.isPublic,
      link: did != null ? this.datasetLink(did) : null,
    };
  }

  private toWorkflowSummary(w: DashboardWorkflow): AgentWorkflowSummary {
    const wid = w.workflow.wid;
    return {
      wid,
      name: w.workflow.name,
      description: w.workflow.description,
      link: wid != null ? this.workflowLink(wid) : null,
    };
  }

  private toSearchHit(entry: DashboardEntry): AgentSearchHit {
    return {
      type: entry.type,
      id: entry.id,
      name: entry.name,
      link: this.searchHitLink(entry),
    };
  }

  private searchHitLink(entry: DashboardEntry): string | null {
    if (entry.id == null) {
      return null;
    }
    if (entry.type === EntityType.Workflow) {
      return this.workflowLink(entry.id);
    }
    if (entry.type === EntityType.Dataset) {
      return this.datasetLink(entry.id);
    }
    return null;
  }

  private workflowLink(wid: number): string {
    return `${DASHBOARD_USER_WORKSPACE}/${wid}`;
  }

  private datasetLink(did: number): string {
    return `${DASHBOARD_USER_DATASET}/${did}`;
  }

  private emptyWorkflowContent(): WorkflowContent {
    return {
      operators: [],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400, executionMode: ExecutionMode.PIPELINED },
    };
  }

  private emptyFilterParameters(): SearchFilterParameters {
    return {
      createDateStart: null,
      createDateEnd: null,
      modifiedDateStart: null,
      modifiedDateEnd: null,
      owners: [],
      ids: [],
      operators: [],
      projectIds: [],
    };
  }

  private toErrorMessage(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      return e.error?.message ?? e.message ?? `Request failed with status ${e.status}.`;
    }
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  }
}
