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
import type { TestUser } from "../fixtures";
import { errorResponse } from "./access";
import { sessionFor } from "../session";
import type { MockDb } from "./index";

/** Sign-in, as AuthResource.scala answers it. */
export function authHandlers(db: MockDb) {
  return [
    // POST /auth/login {username, password} -> {accessToken}. The username is the login name, not the email.
    http.post("/api/auth/login", async ({ request }) => {
      const { username, password } = (await request.json()) as { username: string; password: string };
      const user = db.users.find(candidate => candidate.name === username && candidate.password === password);
      if (!user) {
        // The real body is Dropwizard's generic one, not the server's "Login credentials are incorrect."
        return HttpResponse.json({ code: 401, message: "HTTP 401 Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({ accessToken: sessionFor(user).token });
    }),

    // POST /auth/register {username, email, password} -> {accessToken}, for an account made inactive, or
    // {accessToken: null} where a code is emailed first. A name or an email that is taken is a 406.
    http.post("/api/auth/register", async ({ request }) => {
      const registration = (await request.json()) as { username: string; email: string; password: string };
      const refused = refusal(db, registration);
      if (refused) return refused;
      if (db.signUp.emailCode) return HttpResponse.json({ accessToken: null });
      return HttpResponse.json({ accessToken: sessionFor(makeAccount(db, registration)).token });
    }),

    // POST /auth/register/verify {username, email, password, code} -> {accessToken}. The code is the one emailed.
    http.post("/api/auth/register/verify", async ({ request }) => {
      const registration = (await request.json()) as {
        username: string;
        email: string;
        password: string;
        code: string;
      };
      const refused = refusal(db, registration);
      if (refused) return refused;
      if (registration.code !== emailedCode) return errorResponse(406, "The code is wrong, or it has expired.");
      return HttpResponse.json({ accessToken: sessionFor(makeAccount(db, registration)).token });
    }),
  ];
}

/** The code the fake backend emails to whoever signs up where a code is asked for. */
export const emailedCode = "421337";

function refusal(db: MockDb, { username, email, password }: { username: string; email: string; password: string }) {
  if (!username.trim()) return errorResponse(406, "Username cannot be empty");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return errorResponse(406, "Invalid email format");
  if (!password) return errorResponse(406, "Password cannot be empty");
  if (db.users.some(user => user.name === username)) return errorResponse(406, "Username exists already.");
  if (db.users.some(user => user.email === email)) return errorResponse(406, "Email exists already.");
  return undefined;
}

function makeAccount(db: MockDb, { username, email, password }: { username: string; email: string; password: string }) {
  const user: TestUser = {
    uid: Math.max(...db.users.map(each => each.uid)) + 1,
    name: username,
    email,
    password,
    role: "INACTIVE",
  };
  db.users.push(user);
  return user;
}

/**
 * The account a request is signed in as, read from its token's claims as JwtAuthFilter.scala does,
 * or the answer the services give instead: 401 without a token they accept, and 403 for an account
 * that is not active (the endpoints allow the roles REGULAR and ADMIN only).
 */
export function signedInUser(db: MockDb, request: Request): TestUser | Response {
  const { userId, role } = claimsOf(request);
  const user = db.users.find(candidate => candidate.uid === userId);
  if (!user) return new HttpResponse(null, { status: 401 });
  if (role !== "REGULAR" && role !== "ADMIN") {
    return HttpResponse.json({ code: 403, message: "User not authorized." }, { status: 403 });
  }
  return user;
}

/** The claims of the request's token. Like the services, it trusts them; unlike them, it checks no signature. */
function claimsOf(request: Request): { userId?: unknown; role?: unknown } {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)) as { userId?: unknown; role?: unknown };
  } catch {
    return {};
  }
}
