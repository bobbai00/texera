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

// Stub the lazily-imported deep-chat web component so the spec does not load
// (or register) the real custom element.
vi.mock("deep-chat", () => ({}));

import { TestBed } from "@angular/core/testing";
import { DashboardAgentPageComponent } from "./dashboard-agent-page.component";
import { DashboardAgentRuntimeService } from "../../service/runtime/dashboard-agent-runtime.service";

describe("DashboardAgentPageComponent", () => {
  let runtimeStub: {
    runTurn: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    getModelId: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    runtimeStub = {
      runTurn: vi.fn(),
      setModel: vi.fn(),
      getModelId: vi.fn().mockReturnValue("gpt-4.1-mini"),
    };

    TestBed.configureTestingModule({
      imports: [DashboardAgentPageComponent],
      providers: [{ provide: DashboardAgentRuntimeService, useValue: runtimeStub }],
    });
  });

  it("should create", () => {
    const fixture = TestBed.createComponent(DashboardAgentPageComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("wires a streaming deep-chat connect handler after the view initializes", async () => {
    const fixture = TestBed.createComponent(DashboardAgentPageComponent);
    fixture.detectChanges(); // render <deep-chat> and resolve the @ViewChild

    await fixture.componentInstance.ngAfterViewInit();

    const chat = fixture.componentInstance.chatRef.nativeElement as any;
    expect(chat.connect.stream).toBe(true);
    expect(typeof chat.connect.handler).toBe("function");
  });

  it("updates the runtime model when the selection changes", () => {
    const fixture = TestBed.createComponent(DashboardAgentPageComponent);

    (fixture.componentInstance as any).onModelChange("claude-sonnet-4");

    expect(runtimeStub.setModel).toHaveBeenCalledWith("claude-sonnet-4");
  });
});
