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
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { server } from "@/testing/server";
import { listenToSession, signInAs } from "@/testing/session";
import { api, ApiError } from "./api-client";
import { getSession } from "./session";

/** Answers calls to one endpoint with a response, and keeps the requests for the test to check. */
function answer(method: "get" | "post" | "delete", path: string, response: () => Response): Request[] {
  const received: Request[] = [];
  server.use(
    http[method](`/api${path}`, ({ request }) => {
      received.push(request.clone());
      return response();
    })
  );
  return received;
}

describe("api", () => {
  describe("requests and responses", () => {
    it("reads a JSON response", async () => {
      answer("get", "/dataset/list", () => HttpResponse.json([{ dataset: { did: 1, name: "iris" } }]));

      await expect(api("/dataset/list")).resolves.toEqual([{ dataset: { did: 1, name: "iris" } }]);
    });

    it("sends a JSON body", async () => {
      const received = answer("post", "/dataset/create", () => HttpResponse.json({}));

      await api("/dataset/create", { method: "POST", json: { datasetName: "iris", isDatasetPublic: false } });

      expect(received[0].headers.get("Content-Type")).toBe("application/json");
      expect(await received[0].json()).toEqual({ datasetName: "iris", isDatasetPublic: false });
    });

    it("sends text as text/plain", async () => {
      const received = answer("post", "/dataset/1/version/create", () => HttpResponse.json({}));

      await api("/dataset/1/version/create", { method: "POST", body: "first upload" });

      expect(received[0].headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await received[0].text()).toBe("first upload");
    });

    it("sends bytes as application/octet-stream", async () => {
      const received = answer("post", "/dataset/multipart-upload/part", () => HttpResponse.json({}));

      await api("/dataset/multipart-upload/part", { method: "POST", body: new Blob(["5.1,3.5"]) });

      expect(received[0].headers.get("Content-Type")).toBe("application/octet-stream");
      expect(await received[0].text()).toBe("5.1,3.5");
    });

    it("encodes the query with encodeURIComponent, so a space is %20 and a plus is %2B", async () => {
      const received = answer("post", "/dataset/multipart-upload/part", () => HttpResponse.json({}));

      await api("/dataset/multipart-upload/part", {
        method: "POST",
        query: { filePath: "v1 - first/a+b.csv", partNumber: 2 },
        body: new Blob(["5.1"]),
      });

      expect(new URL(received[0].url).search).toBe("?filePath=v1%20-%20first%2Fa%2Bb.csv&partNumber=2");
    });

    it("reads a text response", async () => {
      answer("get", "/access/dataset/owner/1", () => HttpResponse.text("texera"));

      await expect(api("/access/dataset/owner/1", { responseType: "text" })).resolves.toBe("texera");
    });

    it("ignores the body when told to", async () => {
      answer("delete", "/dataset/1", () => new HttpResponse(null, { status: 204 }));

      await expect(api("/dataset/1", { method: "DELETE", responseType: "void" })).resolves.toBeUndefined();
    });
  });

  describe("the session", () => {
    it("sends the session's token", async () => {
      const session = signInAs(admin);
      const received = answer("get", "/dataset/list", () => HttpResponse.json([]));

      await api("/dataset/list");

      expect(received[0].headers.get("Authorization")).toBe(`Bearer ${session.token}`);
    });

    it("sends no token without a session", async () => {
      const received = answer("get", "/dataset/list", () => HttpResponse.json([]));

      await api("/dataset/list");

      expect(received[0].headers.has("Authorization")).toBe(false);
    });

    it("sends no expired token", async () => {
      signInAs(admin, { expiresAt: Date.now() - 60_000 });
      const received = answer("get", "/dataset/list", () => HttpResponse.json([]));

      await api("/dataset/list");

      expect(received[0].headers.has("Authorization")).toBe(false);
    });

    it("ends the session when the server rejects its token", async () => {
      signInAs(admin);
      const listener = listenToSession();
      answer("get", "/dataset/list", () => new HttpResponse(null, { status: 401 }));

      await expect(api("/dataset/list")).rejects.toMatchObject({ status: 401 });

      expect(getSession()).toBeNull();
      expect(listener).toHaveBeenCalled();
    });

    it("leaves the session alone on a 401 to a call that carried no token", async () => {
      const listener = listenToSession();
      answer("get", "/dataset/list", () => new HttpResponse(null, { status: 401 }));

      await expect(api("/dataset/list")).rejects.toMatchObject({ status: 401 });

      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps the session on a 403", async () => {
      signInAs(admin);
      answer("get", "/dataset/1", () => HttpResponse.json({ code: 403, message: "Forbidden" }, { status: 403 }));

      await expect(api("/dataset/1")).rejects.toMatchObject({ status: 403 });

      expect(getSession()).not.toBeNull();
    });
  });

  describe("errors", () => {
    it.each([
      [
        "Dropwizard's {code, message}",
        () => HttpResponse.json({ code: 400, message: "No such dataset" }, { status: 400 }),
      ],
      ["a bare {message}", () => HttpResponse.json({ message: "No such dataset" }, { status: 400 })],
      ["plain text", () => HttpResponse.text("No such dataset", { status: 400 })],
    ])("reads the message from %s", async (_, response) => {
      answer("get", "/dataset/1", response);

      await expect(api("/dataset/1")).rejects.toEqual(new ApiError(400, "No such dataset"));
    });

    it.each([
      ["an empty body", () => new HttpResponse(null, { status: 502 })],
      ["an HTML page", () => HttpResponse.html("<h1>502 Bad Gateway</h1>", { status: 502 })],
      ["JSON without a message", () => HttpResponse.json({ code: 502 }, { status: 502 })],
      ["malformed JSON", () => new HttpResponse("{", { status: 502, headers: { "Content-Type": "application/json" } })],
    ])("falls back to the status when the error has %s", async (_, response) => {
      answer("get", "/dataset/1", response);

      await expect(api("/dataset/1")).rejects.toEqual(new ApiError(502, "The server returned an error (502)."));
    });

    it("rejects a successful response whose JSON is malformed", async () => {
      answer("get", "/dataset/list", () => HttpResponse.text("[{"));

      await expect(api("/dataset/list")).rejects.toEqual(
        new ApiError(200, "The server sent a response that could not be read.")
      );
    });

    it("reports a server that cannot be reached as status 0", async () => {
      answer("get", "/dataset/list", () => HttpResponse.error());

      await expect(api("/dataset/list")).rejects.toEqual(
        new ApiError(0, "Could not reach the server. Check your connection and try again.")
      );
    });

    it("lets a cancelled call fail as an abort", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(api("/dataset/list", { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    });
  });
});
