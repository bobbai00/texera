/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { HttpClient } from "@angular/common/http";
import { AppSettings } from "../../../common/app-setting";

export interface PythonEnvironment {
  veid: number;
  name: string;
  packages: Record<string, string>;
}

/**
 * The rule for an environment's name, the Dashboard's own (PythonRequirements.validateName in
 * common/workflow-core): a letter or digit, then up to 127 letters, digits, '.', '_' or '-'. The
 * Environments page checks it before it asks the Dashboard to save a name.
 */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What a user is told about a name outside ENVIRONMENT_NAME_PATTERN. */
export const ENVIRONMENT_NAME_RULE =
  "Environment name must start with a letter or digit and contain only letters, digits, '.', '_' and '-', at most 128 characters.";

@Injectable({ providedIn: "root" })
export class PythonEnvironmentService {
  constructor(private http: HttpClient) {}

  // The environments a user keeps belong to the user, not to a computing unit, so the Dashboard
  // stores and checks them at /environments.
  create(name: string, packages: Record<string, string>): Observable<PythonEnvironment> {
    return this.http.post<PythonEnvironment>(`${AppSettings.getApiEndpoint()}/environments`, { name, packages });
  }

  update(veid: number, name: string, packages: Record<string, string>): Observable<PythonEnvironment> {
    return this.http.put<PythonEnvironment>(`${AppSettings.getApiEndpoint()}/environments/${veid}`, { name, packages });
  }

  list(): Observable<PythonEnvironment[]> {
    return this.http.get<PythonEnvironment[]>(`${AppSettings.getApiEndpoint()}/environments`);
  }

  delete(veid: number): Observable<void> {
    return this.http.delete<void>(`${AppSettings.getApiEndpoint()}/environments/${veid}`);
  }
}
