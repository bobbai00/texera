/*
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

import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { VIZ_FRAME_CSP, VIZ_FRAME_PATH } from "./security-headers.ts";

// The visualization host page needs its own CSP (see security-headers.ts).
function vizFrameHeaders(): Plugin {
  return {
    name: "texera-viz-frame-headers",
    configureServer: server => {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] === VIZ_FRAME_PATH) res.setHeader("Content-Security-Policy", VIZ_FRAME_CSP);
        next();
      });
    },
  };
}

// In development the gateway (Envoy, http://localhost:8088) serves the app by proxying to this
// server, so every API call is same-origin and no proxy table lives here. Open the app at the
// gateway, not at the vite port.
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // Absolute so the packages test project (rooted elsewhere) does not look for routes.
      routesDirectory: resolve(import.meta.dirname, "src/routes"),
      generatedRouteTree: resolve(import.meta.dirname, "src/routeTree.gen.ts"),
    }),
    react({ compiler: true }),
    tailwindcss(),
    vizFrameHeaders(),
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    port: 5174,
    strictPort: true,
    // The gateway container reaches the dev server through host.docker.internal.
    host: true,
    allowedHosts: true,
    hmr: { clientPort: 8088 },
  },
  build: {
    target: "es2022",
    sourcemap: "hidden",
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "app", root: import.meta.dirname, environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
      },
      {
        extends: true,
        test: {
          name: "packages",
          root: resolve(import.meta.dirname, "../packages"),
          environment: "jsdom",
          include: ["*/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
