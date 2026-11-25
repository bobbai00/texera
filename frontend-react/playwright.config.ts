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

import { defineConfig, devices } from "@playwright/test";
import { gateway } from "./e2e/support/backend.ts";
import type { Options } from "./e2e/support/fixtures.ts";

// The end-to-end tests run against a real backend, `yarn stack:up`, whose gateway serves both apps.
// Each project runs the same scenarios: "react" on this app, "angular" on the app it replaces.
export default defineConfig<Options>({
  testDir: "./e2e",
  globalSetup: "./e2e/support/global-setup.ts",
  fullyParallel: true,
  // Executing a workflow on a computing unit that is busy with the other tests' can take a while.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "react",
      // The build at /alpha/ on the gateway, or a dev server: E2E_REACT_URL=http://localhost:5173/alpha/
      use: { appKind: "react", baseURL: process.env.E2E_REACT_URL ?? `${gateway}/alpha/` },
    },
    {
      name: "angular",
      use: { appKind: "angular", baseURL: `${gateway}/` },
      // What the React app does beside the Angular one, and its workflow editor, which is its own.
      testIgnore: ["migration/**", "workflow/**", "compute/**", "hub/**"],
    },
  ],
});
