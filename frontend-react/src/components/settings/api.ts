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

// The deployment's settings that anyone may read, which an administrator changes (ConfigResource.scala): which
// areas the navigation shows, and how large an upload may be. Every value is a string.

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { publicKey } from "@/lib/session";

export type Settings = Record<string, string>;

export const settingsKey = [...publicKey, "settings"] as const;

export function publicSettingsQuery() {
  return queryOptions({
    queryKey: settingsKey,
    queryFn: () => api<Settings>("/config/settings/public"),
    staleTime: 60_000,
  });
}

/** Whether a switch of the settings is on. One the deployment does not have is on. */
export function isOn(settings: Settings, key: string): boolean {
  return settings[key] !== "false";
}
