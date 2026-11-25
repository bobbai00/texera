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

const roles = ["INACTIVE", "RESTRICTED", "REGULAR", "ADMIN"] as const;
export type Role = (typeof roles)[number];

/**
 * The key that a query of what anyone may read starts with, such as how people sign in. Whatever else the app
 * holds is the signed-in user's, and goes when the session changes.
 */
export const publicKey = ["public"] as const;

/** The signed-in user, read from the claims of the token the Dashboard Service issued (JwtAuth.scala). */
export interface Session {
  token: string;
  userId: number;
  /** The display name (the token's `sub`), not the login name. */
  name: string;
  email: string | null;
  role: Role;
  /** Where the user's picture is, if they have one. */
  avatar?: string;
  /** When the token expires, in epoch milliseconds. */
  expiresAt: number;
}

/** Where the Angular app keeps the token too: on the same origin, both apps share one sign-in. */
const tokenKey = "access_token";
/** The server still accepts a token for 30 seconds past its expiry. */
const clockSkewMs = 30_000;

const listeners = new Set<() => void>();
let cache: { token: string | null; session: Session | null } = { token: null, session: null };

/** The current session, or null. A token that is expired or cannot be read is dropped. */
export function getSession(): Session | null {
  const token = localStorage.getItem(tokenKey);
  if (token !== cache.token) cache = { token, session: token === null ? null : readToken(token) };
  const usable = cache.session !== null && Date.now() <= cache.session.expiresAt + clockSkewMs;
  if (token !== null && !usable) {
    localStorage.removeItem(tokenKey);
    cache = { token: null, session: null };
    // Listeners hear of it after this call, which may run while a component renders.
    queueMicrotask(notify);
  }
  return cache.session;
}

/** Starts the session of a token the server issued on sign-in, in the Angular app too. */
export function startSession(token: string): Session {
  const session = readToken(token);
  if (!session) throw new Error("The server sent a sign-in token that could not be read.");
  localStorage.setItem(tokenKey, token);
  notify();
  return session;
}

/** Ends the session, in the Angular app too. */
export function signOut(): void {
  localStorage.removeItem(tokenKey);
  notify();
}

/** Calls listener whenever the session changes: here, in another tab, or in the Angular app. */
export function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // A null key means the other page cleared all of its storage.
    if (event.key === tokenKey || event.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether the account may use Texera: INACTIVE and RESTRICTED accounts get 403 from every dataset call. */
export function isActive(session: Session): boolean {
  return session.role === "REGULAR" || session.role === "ADMIN";
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Reads the claims of a JWT. The signature is the server's to check; a token that does not fit is null. */
function readToken(token: string): Session | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { sub, userId, email = null, role, exp, avatar, googleAvatar } = claims;
    if (typeof sub !== "string" || typeof userId !== "number" || typeof exp !== "number" || !isRole(role)) return null;
    if (email !== null && typeof email !== "string") return null;
    // The claim was googleAvatar until pictures stopped being Google's only.
    const picture = [avatar, googleAvatar].find(each => typeof each === "string" && each !== "") as string | undefined;
    return { token, userId, name: sub, email, role, ...(picture && { avatar: picture }), expiresAt: exp * 1000 };
  } catch {
    return null;
  }
}

function isRole(value: unknown): value is Role {
  return roles.some(role => role === value);
}
