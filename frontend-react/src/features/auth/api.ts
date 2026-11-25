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

// The calls the app makes to sign in and to make an account: the Dashboard Service's /auth endpoints
// (AuthResource.scala), and what the deployment allows before anyone signs in (ConfigResource.scala).

import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { publicKey, type Session, startSession } from "@/lib/session";

/** Signs in with a local account's login name (not its email) and starts the session. */
export async function signIn(username: string, password: string): Promise<Session> {
  const { accessToken } = await api<{ accessToken: string }>("/auth/login", {
    method: "POST",
    json: { username, password },
  }).catch((error: unknown) => {
    // The server's own 401 body only says "HTTP 401 Unauthorized".
    throw error instanceof ApiError && error.status === 401
      ? new ApiError(401, "Incorrect username or password.")
      : error;
  });
  return startSession(accessToken);
}

/** How people get into this deployment, before they have signed in. */
export interface SignInOptions {
  /** Whether people may make a local account themselves. */
  signUp: boolean;
  /** Whether a new account's email gets a code that the account is made with. */
  emailCode: boolean;
}

export function signInOptionsQuery() {
  return queryOptions({
    queryKey: [...publicKey, "signInOptions"],
    queryFn: async (): Promise<SignInOptions> => {
      const { localLogin, emailVerification } = await api<{ localLogin: boolean; emailVerification: boolean }>(
        "/config/pre-login"
      );
      return { signUp: localLogin, emailCode: emailVerification };
    },
    staleTime: Infinity,
  });
}

export interface Registration {
  username: string;
  email: string;
  password: string;
}

/**
 * Asks for an account. Where no code is needed, it is made, inactive until an administrator activates it, and
 * the user is signed in to it. Where one is, the code is emailed and nothing is made yet: this gives back
 * undefined, and verifyRegistration() finishes it.
 */
export async function register(registration: Registration): Promise<Session | undefined> {
  const { accessToken } = await api<{ accessToken: string | null }>("/auth/register", {
    method: "POST",
    json: registration,
  });
  return accessToken ? startSession(accessToken) : undefined;
}

/** Makes the account that register() emailed a code for, with the same fields and the code. */
export async function verifyRegistration(registration: Registration, code: string): Promise<Session> {
  const { accessToken } = await api<{ accessToken: string }>("/auth/register/verify", {
    method: "POST",
    json: { ...registration, code },
  });
  return startSession(accessToken);
}
