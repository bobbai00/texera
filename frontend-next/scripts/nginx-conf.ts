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

// Prints the nginx server block that serves dist/ with the headers this app is built to run under
// (security-headers.ts), so a deployment cannot drift from them. The frontend image runs it.
//
//   bun scripts/nginx-conf.ts > default.conf
import { APP_CSP, VIZ_FRAME_CSP, VIZ_FRAME_PATH } from "../security-headers.ts";

const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

export function nginxConf(port = 8080): string {
  const appHeaders = [
    `add_header Content-Security-Policy ${quote(APP_CSP)} always;`,
    `add_header X-Content-Type-Options "nosniff" always;`,
    `add_header Referrer-Policy "no-referrer" always;`,
  ];
  const indent = (lines: string[], depth: number) => lines.map(l => `${"  ".repeat(depth)}${l}`).join("\n");
  return `server {
  listen ${port};
  root /usr/share/nginx/html;
${indent(appHeaders, 1)}

  # Workflow-produced HTML runs here, sandboxed, under its own policy.
  location = ${VIZ_FRAME_PATH} {
    add_header Content-Security-Policy ${quote(VIZ_FRAME_CSP)} always;
    add_header X-Content-Type-Options "nosniff" always;
  }

  # Hashed build output never changes under the same name.
  location /assets/ {
${indent(appHeaders, 2)}
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }

  # Client-side routes all load the app.
  location / {
    try_files $uri /index.html;
  }
}
`;
}

if (import.meta.main) process.stdout.write(nginxConf());
