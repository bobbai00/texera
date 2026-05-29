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
import { of } from "rxjs";
import { simulateReadableStream } from "ai";
import { DashboardAgentRuntimeService } from "./dashboard-agent-runtime.service";
import { DashboardAgentToolsService } from "../tools/dashboard-agent-tools.service";
import { DASHBOARD_AGENT_MODEL_FACTORY } from "../model/dashboard-agent-model";
import { WorkflowPersistService } from "../../../common/service/workflow-persist/workflow-persist.service";
import { DatasetService } from "../../../dashboard/service/user/dataset/dataset.service";
import { SearchService } from "../../../dashboard/service/user/search.service";
import { DashboardWorkflow } from "../../../dashboard/type/dashboard-workflow.interface";
import { ExecutionMode } from "../../../common/type/workflow";

function makeWorkflow(wid: number, name: string): DashboardWorkflow {
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

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// Minimal LanguageModelV2 fake, built without `ai/test` (whose import chain
// pulls in `msw`, which isn't a dependency here). streamText only needs
// `specificationVersion: "v2"` and `doStream`.
function makeModel(doStream: () => Promise<{ stream: ReadableStream<any> }>): any {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate is not used in these tests");
    },
    doStream,
  };
}

// A model that first calls the `listWorkflows` tool, then (after the tool
// result is fed back) streams a final text answer.
function toolThenTextModel(): any {
  let call = 0;
  return makeModel(async () => {
    call += 1;
    const chunks =
      call === 1
        ? [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-1", toolName: "listWorkflows", input: "{}" },
            { type: "finish", finishReason: "tool-calls", usage: USAGE },
          ]
        : [
            { type: "text-start", id: "txt" },
            { type: "text-delta", id: "txt", delta: "You have " },
            { type: "text-delta", id: "txt", delta: "1 workflow." },
            { type: "text-end", id: "txt" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ];
    return { stream: simulateReadableStream({ chunks: chunks as any }) };
  });
}

// A model whose stream emits an error part.
function erroringModel(): any {
  return makeModel(async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error("model failed") },
        { type: "finish", finishReason: "error", usage: USAGE },
      ] as any,
    }),
  }));
}

describe("DashboardAgentRuntimeService", () => {
  let runtime: DashboardAgentRuntimeService;
  let model: any;
  let workflowPersistService: { retrieveWorkflowsBySessionUser: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workflowPersistService = {
      retrieveWorkflowsBySessionUser: vi.fn().mockReturnValue(of([makeWorkflow(42, "pipeline")])),
    };

    TestBed.configureTestingModule({
      providers: [
        DashboardAgentRuntimeService,
        DashboardAgentToolsService,
        { provide: DASHBOARD_AGENT_MODEL_FACTORY, useValue: () => model },
        { provide: WorkflowPersistService, useValue: workflowPersistService },
        { provide: DatasetService, useValue: {} },
        { provide: SearchService, useValue: {} },
      ],
    });
    runtime = TestBed.inject(DashboardAgentRuntimeService);
  });

  function fakeSignals() {
    return { onResponse: vi.fn(), onClose: vi.fn(), onOpen: vi.fn() };
  }

  function streamedText(signals: ReturnType<typeof fakeSignals>): string {
    return signals.onResponse.mock.calls
      .map(call => call[0])
      .filter((r: any) => typeof r.text === "string")
      .map((r: any) => r.text)
      .join("");
  }

  it("should be created", () => {
    expect(runtime).toBeTruthy();
  });

  it("tracks the selected model", () => {
    runtime.setModel("gpt-4.1");
    expect(runtime.getModelId()).toBe("gpt-4.1");
  });

  it("executes a frontend tool the model calls, then streams the final text", async () => {
    model = toolThenTextModel();
    const signals = fakeSignals();

    await runtime.runTurn({ messages: [{ role: "user", text: "list my workflows" }] }, signals);

    // the tool ran against the existing service
    expect(workflowPersistService.retrieveWorkflowsBySessionUser).toHaveBeenCalledTimes(1);
    // the model's prose was streamed to deep-chat as text deltas
    expect(streamedText(signals)).toBe("You have 1 workflow.");
    expect(signals.onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a stream error through signals.onResponse without closing", async () => {
    model = erroringModel();
    const signals = fakeSignals();

    await runtime.runTurn({ messages: [{ role: "user", text: "hi" }] }, signals);

    const errored = signals.onResponse.mock.calls.map(c => c[0]).some((r: any) => typeof r.error === "string");
    expect(errored).toBe(true);
    expect(signals.onClose).not.toHaveBeenCalled();
  });
});
