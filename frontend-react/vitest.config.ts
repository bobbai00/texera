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

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          // `yarn test`: unit and component tests on jsdom, with MSW as the backend.
          extends: true,
          test: {
            name: "unit",
            environment: "jsdom",
            include: ["src/**/*.test.{ts,tsx}", "shared-editing-service/**/*.test.ts"],
            setupFiles: ["./src/testing/setup.ts"],
            // Dates read the same on every machine.
            env: { TZ: "UTC" },
          },
        },
        {
          // `yarn test:stories`: every story rendered as a test in the installed Chrome.
          extends: true,
          plugins: [storybookTest({ configDir: ".storybook", storybookScript: "yarn storybook --no-open" })],
          test: {
            name: "storybook",
            browser: {
              enabled: true,
              headless: true,
              provider: playwright({ launchOptions: { channel: "chrome" } }),
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  })
);
