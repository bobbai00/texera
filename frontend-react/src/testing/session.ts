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

import { onTestFinished, vi } from "vitest";
import { type Session, subscribe } from "@/lib/session";
import type { TestUser } from "./fixtures";

const weekMs = 7 * 24 * 60 * 60 * 1000;

/** A JWT with these claims and no real signature: the app reads the claims and never checks it. */
export function makeToken(claims: Record<string, unknown>): string {
  const encode = (part: object) => {
    const bytes = new TextEncoder().encode(JSON.stringify(part));
    return btoa(String.fromCharCode(...bytes))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  };
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.unsigned`;
}

/** The session a user gets by signing in: the claims JwtAuth.scala writes, valid for a week unless told otherwise. */
export function sessionFor(user: TestUser, { expiresAt = Date.now() + weekMs } = {}): Session {
  const exp = Math.floor(expiresAt / 1000);
  const token = makeToken({ sub: user.name, userId: user.uid, email: user.email, role: user.role, exp });
  return { token, userId: user.uid, name: user.name, email: user.email, role: user.role, expiresAt: exp * 1000 };
}

/** Signs a user in for a test that renders nothing: their token goes where the app keeps it. */
export function signInAs(user: TestUser, options?: { expiresAt?: number }): Session {
  const session = sessionFor(user, options);
  localStorage.setItem("access_token", session.token);
  return session;
}

/** A listener of the session's changes, for the test to check. It stops listening when the test ends. */
export function listenToSession() {
  const listener = vi.fn();
  onTestFinished(subscribe(listener));
  return listener;
}
