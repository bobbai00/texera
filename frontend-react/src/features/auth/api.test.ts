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
import { getSession } from "@/lib/session";
import { admin, reader } from "@/testing/fixtures";
import { server } from "@/testing/server";
import { signIn } from "./api";

describe("signIn", () => {
  it("signs in with the login name and starts the session", async () => {
    const session = await signIn(reader.name, reader.password);

    expect(session).toMatchObject({ userId: reader.uid, name: reader.name, email: reader.email, role: "REGULAR" });
    expect(getSession()).toEqual(session);
  });

  it("rejects a wrong password in plain words and starts no session", async () => {
    await expect(signIn(admin.name, "wrong")).rejects.toThrow("Incorrect username or password.");

    expect(getSession()).toBeNull();
  });

  it("passes on the server's message when the server fails", async () => {
    server.use(
      http.post("/api/auth/login", () =>
        HttpResponse.json({ code: 500, message: "There was an error processing your request." }, { status: 500 })
      )
    );

    await expect(signIn(admin.name, admin.password)).rejects.toThrow("There was an error processing your request.");
  });

  it("rejects a token it cannot read and starts no session", async () => {
    server.use(http.post("/api/auth/login", () => HttpResponse.json({ accessToken: "not-a-token" })));

    await expect(signIn(admin.name, admin.password)).rejects.toThrow(
      "The server sent a sign-in token that could not be read."
    );
    expect(getSession()).toBeNull();
  });
});
