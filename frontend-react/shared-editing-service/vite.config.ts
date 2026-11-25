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

// Builds the shared editing service into one file that Node runs without anything installed beside it:
// `yarn build:shared-editing` writes dist-shared-editing/main.js.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // The app's public files are the app's, not the service's.
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  // Everything the service uses goes into the file.
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: fileURLToPath(new URL("main.ts", import.meta.url)),
    outDir: fileURLToPath(new URL("../dist-shared-editing", import.meta.url)),
    emptyOutDir: true,
    target: "node24",
    // ws loads these two only if they are installed, to go faster; the service does without them.
    rolldownOptions: { external: ["bufferutil", "utf-8-validate"] },
  },
});
