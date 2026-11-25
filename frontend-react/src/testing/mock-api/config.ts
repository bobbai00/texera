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

import { http, HttpResponse } from "msw/http";
import { errorResponse } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** The settings an admin can change, as a new install has them (default.conf). Every value is a string. */
export const defaultSettings: Record<string, string> = {
  hub_enabled: "true",
  home_enabled: "true",
  workflow_enabled: "true",
  dataset_enabled: "true",
  model_enabled: "true",
  your_work_enabled: "true",
  workflows_enabled: "true",
  datasets_enabled: "true",
  models_enabled: "true",
  compute_enabled: "true",
  quota_enabled: "true",
  forum_enabled: "false",
  about_enabled: "true",
  dataset_single_file_upload_max_size_mib: "20",
  dataset_max_number_of_concurrent_uploading_file: "3",
  dataset_multipart_upload_chunk_size_mib: "50",
  dataset_max_number_of_concurrent_uploading_file_chunks: "10",
  model_single_file_upload_max_size_mib: "2048",
  model_max_number_of_concurrent_uploading_file: "3",
  model_multipart_upload_chunk_size_mib: "50",
  model_max_number_of_concurrent_uploading_file_chunks: "10",
  csv_parser_max_columns: "512",
};

/** The settings anyone may read, as ConfigResource.scala answers them. */
export function configHandlers(db: MockDb) {
  return [
    // GET /config/pre-login -> how people get in, before they have signed in.
    http.get("/api/config/pre-login", () =>
      HttpResponse.json({ localLogin: db.signUp.local, emailVerification: db.signUp.emailCode, inviteOnly: false })
    ),

    // GET /config/settings/public -> {name: value}. It needs no token.
    http.get("/api/config/settings/public", () => HttpResponse.json(db.settings)),

    // GET /config/settings -> every setting, for an administrator.
    http.get("/api/config/settings", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      if (user.role !== "ADMIN") return errorResponse(403, "User not authorized.");
      return HttpResponse.json(db.settings);
    }),

    // PUT /config/settings/{key} {value}: only a setting a new install has may be set.
    http.put<{ key: string }>("/api/config/settings/:key", async ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      if (user.role !== "ADMIN") return errorResponse(403, "User not authorized.");
      if (!(params.key in defaultSettings)) return errorResponse(400, `${params.key} is not a setting.`);
      db.settings[params.key] = ((await request.json()) as { value: string }).value;
      return new HttpResponse(null, { status: 204 });
    }),

    // POST /config/settings/reset/{key}: puts a setting back as a new install has it.
    http.post<{ key: string }>("/api/config/settings/reset/:key", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      if (user.role !== "ADMIN") return errorResponse(403, "User not authorized.");
      db.settings[params.key] = defaultSettings[params.key];
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
