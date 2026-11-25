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

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// The generated src/routeTree.gen.ts gets the license header, then the plugin's own first lines.
const routeTreeFileHeader = [
  `/**
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
 */`,
  "/* eslint-disable */",
  "// @ts-nocheck",
  "// noinspection JSUnusedGlobalSymbols",
];

// No backend service sends CORS headers, so the dev server forwards the API to them on the same origin.
// By default it goes to a gateway that routes like bin/single-node (the e2e stack, `yarn stack:up`).
// With TEXERA_LOCAL_DEV=1 it goes to the services of a bin/local-dev.sh stack, with the routes of
// frontend/proxy.config.json that this app calls. A computing unit's socket goes through local development's
// gateway, which checks who may reach the unit, as every deployment's gateway does.
const gateway = process.env.TEXERA_GATEWAY ?? "http://127.0.0.1:18080";
// The shared editing service, in whose rooms workflows are edited: `yarn shared-editing` starts one here.
const sharedEditing = { target: process.env.TEXERA_SHARED_EDITING ?? "http://127.0.0.1:1235", ws: true };
// The language server that helps with Python code: pyright-language-service, where it is running.
const languageServer = { target: process.env.TEXERA_LANGUAGE_SERVER ?? "http://127.0.0.1:3000", ws: true };
const proxy: Record<string, string | ProxyOptions> =
  process.env.TEXERA_LOCAL_DEV === "1"
    ? {
        "/api/compile": "http://localhost:9090",
        "/api/workflow-to-python": "http://localhost:9090",
        "/api/dataset": "http://localhost:9092",
        "/api/model/": "http://localhost:9092",
        "/api/access/dataset": "http://localhost:9092",
        "/api/access/model/": "http://localhost:9092",
        "/api/access/computing-unit": "http://localhost:8888",
        "/api/computing-unit": "http://localhost:8888",
        "/api/cu-image": "http://localhost:8888",
        "/api/config": "http://localhost:9094",
        "/api": "http://localhost:8080",
        "/wsapi": { target: "http://localhost:8086", ws: true },
        "/shared-editing": sharedEditing,
        "/python-language-server": languageServer,
      }
    : {
        "/api": gateway,
        "/wsapi": { target: gateway, ws: true },
        "/shared-editing": sharedEditing,
        "/python-language-server": languageServer,
      };

export default defineConfig({
  // Served beside the Angular app, which keeps "/".
  base: "/alpha/",
  plugins: [
    // Must come before the React plugin.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // A route's tests sit beside it and are not routes.
      routeFileIgnorePattern: "\\.test\\.tsx?$",
      routeTreeFileHeader,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { tsconfigPaths: true },
  // The operator icons are read from the Angular app's assets, one folder up.
  server: { proxy, fs: { allow: [".."] } },
});
