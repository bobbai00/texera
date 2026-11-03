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

// The response headers this app is built to run under. Whatever serves dist/
// (nginx in a deployment, the dev server, the test harness) sends these;
// scripts/nginx-conf.ts renders the nginx form the frontend image uses.

/**
 * The app itself: no inline code, no eval, no third-party origins, Trusted
 * Types required. `storageOrigins` are where dataset files are read from
 * (the object store presigned download URLs point at), the one other origin
 * the browser talks to.
 */
export function appCsp(storageOrigins: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ["connect-src 'self' ws: wss:", ...storageOrigins].join(" "),
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
  ].join("; ");
}

export const APP_CSP = appCsp();

/** Path of the page that hosts workflow-produced HTML (see src/components/data/SandboxedFrame.tsx). */
export const VIZ_FRAME_PATH = "/viz-frame.html";

/**
 * The visualization host. `sandbox allow-scripts` gives it an opaque origin even
 * when opened directly, so the permissive script and style sources below (charts
 * inline their code and load libraries from CDNs) never reach the app's origin,
 * storage or session.
 */
export const VIZ_FRAME_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https: data: blob:",
  "frame-ancestors 'self'",
].join("; ");
