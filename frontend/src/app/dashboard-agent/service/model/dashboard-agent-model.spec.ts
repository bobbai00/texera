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
import { DASHBOARD_AGENT_MODEL_FACTORY } from "./dashboard-agent-model";

describe("DASHBOARD_AGENT_MODEL_FACTORY", () => {
  it("resolves from the root injector without a manual provider", () => {
    // No provider for the token is registered here; if the token were not
    // self-provided, this inject would throw NG0201 (the runtime regression).
    TestBed.configureTestingModule({ providers: [] });

    const factory = TestBed.inject(DASHBOARD_AGENT_MODEL_FACTORY);

    expect(typeof factory).toBe("function");
    // Building a model for a given id constructs an AI SDK model (no network).
    expect(factory("gpt-4.1-mini")).toBeTruthy();
  });
});
