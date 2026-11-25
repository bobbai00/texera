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

// The calls the app makes to the File Service's /model endpoints (ModelResource.scala), beyond what every kind
// of resource shares: finding models and sharing them go through components/resource/api.ts.

import { api } from "@/lib/api-client";
import type { ResourceDeletion } from "@/lib/resource";

/** Deletes a model with all its versions and files. Only its owner may. */
export const modelDeletion: ResourceDeletion = {
  run: id => api(`/model/${id}`, { method: "DELETE", responseType: "void" }),
  consequence: "Its versions and files are deleted too.",
};
