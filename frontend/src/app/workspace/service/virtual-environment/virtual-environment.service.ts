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
import { map } from "rxjs/operators";
import { HttpClient, HttpParams } from "@angular/common/http";
import { AuthService } from "../../../common/service/user/auth.service";
import { AppSettings } from "../../../common/app-setting";

export interface PackageResponse {
  system: string[];
}

export interface PvePackageResponse {
  pveName: string;
  userPackages: string[];
}

export interface UserPveRecord {
  veid: number;
  name: string;
  packages: Record<string, string>;
}

/**
 * The rule for an environment's name, the Dashboard's own (PythonRequirements.validateName in
 * common/workflow-core): a letter or digit, then up to 127 letters, digits, '.', '_' or '-'. The
 * Environments page checks it before saving a name, and the computing unit panel before building
 * one, so every name the Dashboard keeps can be built on a unit.
 */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What a user is told about a name outside ENVIRONMENT_NAME_PATTERN. */
export const ENVIRONMENT_NAME_RULE =
  "Environment name must start with a letter or digit and contain only letters, digits, '.', '_' and '-', at most 128 characters.";

@Injectable({ providedIn: "root" })
export class WorkflowPveService {
  constructor(private http: HttpClient) {}

  // The environments a user keeps belong to the user, not to a computing unit, so the Dashboard
  // stores and checks them at /environments. The /pve calls further down act on one unit's own
  // disk and go to that unit.
  savePve(name: string, packages: Record<string, string>): Observable<UserPveRecord> {
    return this.http.post<UserPveRecord>(`${AppSettings.getApiEndpoint()}/environments`, { name, packages });
  }

  updateUserPve(veid: number, name: string, packages: Record<string, string>): Observable<UserPveRecord> {
    return this.http.put<UserPveRecord>(`${AppSettings.getApiEndpoint()}/environments/${veid}`, { name, packages });
  }

  listUserPves(): Observable<UserPveRecord[]> {
    return this.http.get<UserPveRecord[]>(`${AppSettings.getApiEndpoint()}/environments`);
  }

  deleteUserPve(veid: number): Observable<void> {
    return this.http.delete<void>(`${AppSettings.getApiEndpoint()}/environments/${veid}`);
  }

  getAccessToken(): string | null {
    const token = AuthService.getAccessToken();
    return token && token.trim().length > 0 ? token : null;
  }

  private buildBaseParams(): HttpParams {
    let params = new HttpParams();
    const token = this.getAccessToken();
    if (token) {
      params = params.set("access-token", token);
    }
    return params;
  }

  getSystemPackages(cuid: number): Observable<PackageResponse> {
    const params = this.buildBaseParams().set("cuid", cuid.toString());
    return this.http.get<PackageResponse>(`${AppSettings.getApiEndpoint()}/pve/system`, { params });
  }

  fetchPVEs(cuid: number): Observable<PvePackageResponse[]> {
    const params = this.buildBaseParams().set("cuid", cuid.toString());
    return this.http.get<PvePackageResponse[]>(`${AppSettings.getApiEndpoint()}/pve/pves`, { params });
  }

  getUserPackages(cuid: number, pveName: string): Observable<string[]> {
    return this.fetchPVEs(cuid).pipe(map(pves => pves.find(pve => pve.pveName === pveName)?.userPackages ?? []));
  }

  deleteEnvironments(cuid: number) {
    return this.http.delete(`${AppSettings.getApiEndpoint()}/pve/pves/${cuid}`);
  }

  deletePackage(cuid: number, pveName: string, packageName: string) {
    const params = this.buildBaseParams();

    return this.http.delete<string[]>(
      `${AppSettings.getApiEndpoint()}/pve/${cuid}/${encodeURIComponent(pveName)}/packages/${encodeURIComponent(packageName)}`,
      { params }
    );
  }

  getPveWebSocketUrl(cuid: number, pveName: string, action: string, packages: string[] = []): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = encodeURIComponent(JSON.stringify(packages));

    const token = this.getAccessToken();
    const tokenParam = token ? `&access-token=${encodeURIComponent(token)}` : "";

    return (
      `${protocol}//${window.location.host}/wsapi/pve` +
      `?packages=${query}` +
      `&cuid=${cuid}` +
      `&pveName=${encodeURIComponent(pveName)}` +
      `&action=${action}` +
      tokenParam
    );
  }
}
