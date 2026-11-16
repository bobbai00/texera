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
import { PvePackageResponse, UserPveRecord, WorkflowPveService } from "./virtual-environment.service";
import { commonTestProviders } from "../../../common/testing/test-utils";
import { AuthService } from "../../../common/service/user/auth.service";

describe("WorkflowPveService", () => {
  let service: WorkflowPveService;
  let httpTestingController: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [WorkflowPveService, ...commonTestProviders],
    });
    service = TestBed.inject(WorkflowPveService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("savePve() POSTs name + packages to the Dashboard's /environments and returns the stored row", () => {
    const packages = { numpy: "==1.26.0" };
    const stored: UserPveRecord = { veid: 42, name: "env-a", packages };
    let received: UserPveRecord | undefined;
    service.savePve("env-a", packages).subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments`);
    expect(req.request.method).toBe("POST");
    expect(req.request.body).toEqual({ name: "env-a", packages });
    req.flush(stored, { status: 201, statusText: "Created" });
    expect(received).toEqual(stored);
  });

  it("updateUserPve() PUTs name + packages to /environments/{veid} and returns the stored row", () => {
    const packages = { pandas: "" };
    const stored: UserPveRecord = { veid: 7, name: "env-b", packages };
    let received: UserPveRecord | undefined;
    service.updateUserPve(7, "env-b", packages).subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments/7`);
    expect(req.request.method).toBe("PUT");
    expect(req.request.body).toEqual({ name: "env-b", packages });
    req.flush(stored);
    expect(received).toEqual(stored);
  });

  it("listUserPves() GETs /environments and returns the array of records", () => {
    const records: UserPveRecord[] = [{ veid: 1, name: "env-a", packages: { numpy: "==1.26.0" } }];
    let received: UserPveRecord[] | undefined;
    service.listUserPves().subscribe(resp => {
      received = resp;
    });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments`);
    expect(req.request.method).toBe("GET");
    req.flush(records);
    expect(received).toEqual(records);
  });

  it("deleteUserPve() DELETEs /environments/{veid}", () => {
    let completed = false;
    service.deleteUserPve(9).subscribe({ complete: () => (completed = true) });

    const req = httpTestingController.expectOne(`${AppSettings.getApiEndpoint()}/environments/9`);
    expect(req.request.method).toBe("DELETE");
    req.flush(null, { status: 204, statusText: "No Content" });
    expect(completed).toBe(true);
  });

  describe("token-parameterized endpoints", () => {
    const endpoint = AppSettings.getApiEndpoint();

    afterEach(() => {
      httpTestingController.verify();
      vi.restoreAllMocks();
    });

    describe("getAccessToken()", () => {
      it("returns the token when AuthService yields a non-empty value", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue("jwt-123");
        expect(service.getAccessToken()).toBe("jwt-123");
      });

      it("returns null when AuthService yields null", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
        expect(service.getAccessToken()).toBeNull();
      });

      it("returns null when the token is whitespace-only", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue("   ");
        expect(service.getAccessToken()).toBeNull();
      });
    });

    describe("getSystemPackages()", () => {
      it("GETs /pve/system with cuid and the access-token param when authenticated", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue("jwt-123");
        const response = { system: ["numpy", "pandas"] };
        service.getSystemPackages(5).subscribe(resp => {
          expect(resp).toEqual(response);
        });

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/system`);
        expect(req.request.method).toBe("GET");
        expect(req.request.params.get("cuid")).toBe("5");
        expect(req.request.params.get("access-token")).toBe("jwt-123");
        req.flush(response);
      });

      it("omits the access-token param when unauthenticated", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
        service.getSystemPackages(8).subscribe();

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/system`);
        expect(req.request.params.get("cuid")).toBe("8");
        expect(req.request.params.has("access-token")).toBe(false);
        req.flush({ system: [] });
      });
    });

    describe("fetchPVEs()", () => {
      it("GETs /pve/pves with the cuid param and returns the records", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue("jwt-123");
        const pves: PvePackageResponse[] = [
          { pveName: "env-a", userPackages: ["numpy"] },
          { pveName: "env-b", userPackages: ["scipy"] },
        ];
        service.fetchPVEs(3).subscribe(resp => {
          expect(resp).toEqual(pves);
        });

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/pves`);
        expect(req.request.method).toBe("GET");
        expect(req.request.params.get("cuid")).toBe("3");
        expect(req.request.params.get("access-token")).toBe("jwt-123");
        req.flush(pves);
      });
    });

    describe("getUserPackages()", () => {
      it("returns the userPackages of the matching PVE", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
        const pves: PvePackageResponse[] = [
          { pveName: "env-a", userPackages: ["numpy"] },
          { pveName: "env-b", userPackages: ["scipy", "torch"] },
        ];
        let received: string[] | undefined;
        service.getUserPackages(4, "env-b").subscribe(resp => {
          received = resp;
        });

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/pves`);
        req.flush(pves);
        expect(received).toEqual(["scipy", "torch"]);
      });

      it("returns an empty array when no PVE matches the given name", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
        const pves: PvePackageResponse[] = [{ pveName: "env-a", userPackages: ["numpy"] }];
        let received: string[] | undefined;
        service.getUserPackages(4, "does-not-exist").subscribe(resp => {
          received = resp;
        });

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/pves`);
        req.flush(pves);
        expect(received).toEqual([]);
      });
    });

    describe("deleteEnvironments()", () => {
      it("DELETEs /pve/pves/{cuid}", () => {
        service.deleteEnvironments(11).subscribe();

        const req = httpTestingController.expectOne(`${endpoint}/pve/pves/11`);
        expect(req.request.method).toBe("DELETE");
        req.flush(null);
      });
    });

    describe("deletePackage()", () => {
      it("DELETEs a URL-encoded package path with the access-token param when authenticated", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue("jwt-123");
        service.deletePackage(6, "env a", "pkg+x").subscribe();

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/6/env%20a/packages/pkg%2Bx`);
        expect(req.request.method).toBe("DELETE");
        expect(req.request.params.get("access-token")).toBe("jwt-123");
        req.flush(["remaining"]);
      });

      it("omits the access-token param when unauthenticated", () => {
        vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
        service.deletePackage(6, "env-x", "numpy").subscribe();

        const req = httpTestingController.expectOne(r => r.url === `${endpoint}/pve/6/env-x/packages/numpy`);
        expect(req.request.params.has("access-token")).toBe(false);
        req.flush([]);
      });
    });
  });

  describe("getPveWebSocketUrl()", () => {
    const withLocation = <T>(overrides: Partial<Location>, fn: () => T): T => {
      const original = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...original, ...overrides },
      });
      try {
        return fn();
      } finally {
        Object.defineProperty(window, "location", { configurable: true, value: original });
      }
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uses the ws:// scheme over http and encodes an empty package list with no token param", () => {
      vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
      const url = withLocation({ protocol: "http:", host: "localhost:9000" }, () =>
        service.getPveWebSocketUrl(2, "env-a", "install")
      );
      expect(url).toBe("ws://localhost:9000/wsapi/pve?packages=%5B%5D&cuid=2&pveName=env-a&action=install");
    });

    it("uses the wss:// scheme over https", () => {
      vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
      const url = withLocation({ protocol: "https:", host: "example.com" }, () =>
        service.getPveWebSocketUrl(2, "env-a", "install")
      );
      expect(url.startsWith("wss://example.com/wsapi/pve")).toBe(true);
    });

    it("appends the access-token param when authenticated and URL-encodes it", () => {
      vi.spyOn(AuthService, "getAccessToken").mockReturnValue("a b/c");
      const url = withLocation({ protocol: "http:", host: "localhost:9000" }, () =>
        service.getPveWebSocketUrl(2, "env-a", "install")
      );
      expect(url.endsWith("&access-token=a%20b%2Fc")).toBe(true);
    });

    it("JSON-encodes the packages list and URL-encodes the pveName", () => {
      vi.spyOn(AuthService, "getAccessToken").mockReturnValue(null);
      const url = withLocation({ protocol: "http:", host: "localhost:9000" }, () =>
        service.getPveWebSocketUrl(7, "my env", "uninstall", ["numpy==1.26.0", "scipy"])
      );
      const expectedPackages = encodeURIComponent(JSON.stringify(["numpy==1.26.0", "scipy"]));
      expect(url).toBe(
        `ws://localhost:9000/wsapi/pve?packages=${expectedPackages}&cuid=7&pveName=my%20env&action=uninstall`
      );
    });
  });
});
