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

import { TestBed } from "@angular/core/testing";
import { AppSettings } from "../../../common/app-setting";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { PythonEnvironment, PythonEnvironmentService } from "./python-environment.service";
import { commonTestProviders } from "../../../common/testing/test-utils";

describe("PythonEnvironmentService", () => {
  let service: PythonEnvironmentService;
  let httpTestingController: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PythonEnvironmentService, ...commonTestProviders],
    });
    service = TestBed.inject(PythonEnvironmentService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("create() POSTs name + packages to the Dashboard's /environments and returns the stored row", () => {
    const packages = { numpy: "==1.26.0" };
    const stored: PythonEnvironment = { veid: 42, name: "env-a", packages };
    let received: PythonEnvironment | undefined;
    service.create("env-a", packages).subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments`);
    expect(req.request.method).toBe("POST");
    expect(req.request.body).toEqual({ name: "env-a", packages });
    req.flush(stored, { status: 201, statusText: "Created" });
    expect(received).toEqual(stored);
  });

  it("update() PUTs name + packages to /environments/{veid} and returns the stored row", () => {
    const packages = { pandas: "" };
    const stored: PythonEnvironment = { veid: 7, name: "env-b", packages };
    let received: PythonEnvironment | undefined;
    service.update(7, "env-b", packages).subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments/7`);
    expect(req.request.method).toBe("PUT");
    expect(req.request.body).toEqual({ name: "env-b", packages });
    req.flush(stored);
    expect(received).toEqual(stored);
  });

  it("list() GETs /environments and returns the array of records", () => {
    const records: PythonEnvironment[] = [{ veid: 1, name: "env-a", packages: { numpy: "==1.26.0" } }];
    let received: PythonEnvironment[] | undefined;
    service.list().subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments`);
    expect(req.request.method).toBe("GET");
    req.flush(records);
    expect(received).toEqual(records);
  });

  it("delete() DELETEs /environments/{veid}", () => {
    let completed = false;
    service.delete(9).subscribe({ complete: () => (completed = true) });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments/9`);
    expect(req.request.method).toBe("DELETE");
    req.flush(null, { status: 204, statusText: "No Content" });
    expect(completed).toBe(true);
  });
});
