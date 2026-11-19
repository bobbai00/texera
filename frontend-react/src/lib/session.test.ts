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

import { describe, expect, it, vi } from "vitest";
import { admin, newcomer, reader } from "@/testing/fixtures";
import { listenToSession, makeToken, sessionFor } from "@/testing/session";
import { getSession, isActive, signOut, startSession, subscribe } from "./session";

// The key the Angular app uses, so both apps share one sign-in.
const tokenKey = "access_token";

describe("startSession", () => {
  it("keeps the token where the Angular app keeps it, and reads the user from it", () => {
    const expected = sessionFor(reader);

    expect(startSession(expected.token)).toEqual(expected);
    expect(localStorage.getItem(tokenKey)).toBe(expected.token);
    expect(getSession()).toEqual(expected);
  });

  it("rejects a token it cannot read and stores nothing", () => {
    expect(() => startSession("not-a-token")).toThrow("The server sent a sign-in token that could not be read.");
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });
});

describe("getSession", () => {
  it("reads the user from the token's claims", () => {
    const session = sessionFor({ ...admin, name: "Zoë Ångström" });
    localStorage.setItem(tokenKey, session.token);

    expect(getSession()).toEqual(session);
  });

  it("is null without a token", () => {
    expect(getSession()).toBeNull();
  });

  it("keeps a token within the 30 seconds past its expiry that the server still accepts", () => {
    localStorage.setItem(tokenKey, sessionFor(admin, { expiresAt: Date.now() - 5_000 }).token);

    expect(getSession()).not.toBeNull();
  });

  it("drops an expired token", () => {
    localStorage.setItem(tokenKey, sessionFor(admin, { expiresAt: Date.now() - 60_000 }).token);

    expect(getSession()).toBeNull();
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });

  it.each([
    ["not a JWT", "not-a-token"],
    ["a payload that is not JSON", "header.bm90IGpzb24.signature"],
    ["no user id", makeToken({ sub: "texera", email: "texera", role: "ADMIN", exp: 4102444800 })],
    ["an unknown role", makeToken({ sub: "texera", userId: 1, email: "texera", role: "OWNER", exp: 4102444800 })],
    ["no expiry", makeToken({ sub: "texera", userId: 1, email: "texera", role: "ADMIN" })],
  ])("drops a token with %s", (_, token) => {
    localStorage.setItem(tokenKey, token);

    expect(getSession()).toBeNull();
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });

  it("reads a user without an email", () => {
    localStorage.setItem(
      tokenKey,
      makeToken({ sub: "texera", userId: 1, email: null, role: "ADMIN", exp: 4102444800 })
    );

    expect(getSession()).toMatchObject({ name: "texera", email: null });
  });

  it("reads where the user's picture is, from the claim the token has for it now or the one it had before", () => {
    const claims = { sub: "Ada", userId: 2, email: "ada@example.com", role: "REGULAR", exp: 4102444800 };
    localStorage.setItem(tokenKey, makeToken({ ...claims, avatar: "https://example.com/ada.png" }));
    expect(getSession()?.avatar).toBe("https://example.com/ada.png");

    localStorage.setItem(tokenKey, makeToken({ ...claims, googleAvatar: "https://example.com/ada-before.png" }));
    expect(getSession()?.avatar).toBe("https://example.com/ada-before.png");

    localStorage.setItem(tokenKey, makeToken({ ...claims, avatar: "" }));
    expect(getSession()).not.toHaveProperty("avatar");
  });
});

describe("signOut", () => {
  it("deletes the token", () => {
    localStorage.setItem(tokenKey, sessionFor(admin).token);

    signOut();

    expect(getSession()).toBeNull();
    expect(localStorage.getItem(tokenKey)).toBeNull();
  });
});

describe("subscribe", () => {
  it("tells listeners when the user signs in and out", () => {
    const listener = listenToSession();

    startSession(sessionFor(admin).token);
    signOut();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tells listeners when another tab or the Angular app changes the token", () => {
    const listener = listenToSession();

    window.dispatchEvent(new StorageEvent("storage", { key: tokenKey, newValue: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores other keys in storage", () => {
    const listener = listenToSession();

    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: "dark" }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("tells listeners when it drops an expired token", async () => {
    localStorage.setItem(tokenKey, sessionFor(admin, { expiresAt: Date.now() - 60_000 }).token);
    const listener = listenToSession();

    getSession();

    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  });

  it("stops after the listener unsubscribes", () => {
    const listener = vi.fn();
    subscribe(listener)();

    signOut();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isActive", () => {
  it.each(["REGULAR", "ADMIN"] as const)("lets a %s account use Texera", role => {
    expect(isActive(sessionFor({ ...reader, role }))).toBe(true);
  });

  it.each(["INACTIVE", "RESTRICTED"] as const)("keeps a %s account out", role => {
    expect(isActive(sessionFor({ ...newcomer, role }))).toBe(false);
  });
});
