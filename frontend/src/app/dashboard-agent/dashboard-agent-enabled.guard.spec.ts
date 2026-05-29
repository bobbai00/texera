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
import { Router } from "@angular/router";
import { dashboardAgentEnabledGuard } from "./dashboard-agent-enabled.guard";
import { GuiConfigService } from "../common/service/gui-config.service";

describe("dashboardAgentEnabledGuard", () => {
  let parseUrl: ReturnType<typeof vi.fn>;

  function configure(dashboardAgentEnabled: boolean) {
    parseUrl = vi.fn().mockReturnValue("redirect-url-tree");
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { parseUrl } },
        { provide: GuiConfigService, useValue: { env: { dashboardAgentEnabled } } },
      ],
    });
  }

  function runGuard(): unknown {
    return TestBed.runInInjectionContext(() => dashboardAgentEnabledGuard({} as any, {} as any));
  }

  it("allows activation when the flag is enabled", () => {
    configure(true);
    expect(runGuard()).toBe(true);
    expect(parseUrl).not.toHaveBeenCalled();
  });

  it("redirects to the workflows page when the flag is disabled", () => {
    configure(false);
    expect(runGuard()).toBe("redirect-url-tree");
    expect(parseUrl).toHaveBeenCalledWith("/dashboard/user/workflow");
  });
});
