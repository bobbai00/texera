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

import { getSession, signOut } from "./session";

/** A call that failed: the HTTP status (0 when no response came) and a message to show people. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Query parameters. Each value is encoded once with encodeURIComponent, so a space is %20, never "+". */
  query?: Record<string, string | number | boolean>;
  /** A body sent as JSON. */
  json?: unknown;
  /** A body sent as it is: text as text/plain, a Blob (such as part of a file) as application/octet-stream. */
  body?: string | Blob;
  /** How to read a successful response: as JSON (the default), as text, or not at all. */
  responseType?: "json" | "text" | "void";
  signal?: AbortSignal;
}

/**
 * Calls the Texera API at /api + path, the same origin as the app. Sends the session's token, reads
 * the response as asked, and turns every failure into an ApiError. A 401 to a call that carried a
 * token means the server no longer accepts it, so the session ends.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", query = {}, json, body, responseType = "json", signal } = options;
  const token = getSession()?.token;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  else if (body instanceof Blob) headers.set("Content-Type", "application/octet-stream");

  let response: Response;
  try {
    response = await fetch(`/api${path}${queryString(query)}`, {
      method,
      headers,
      body: json === undefined ? body : JSON.stringify(json),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 401 && token) signOut();
    throw new ApiError(response.status, await errorMessage(response));
  }
  if (responseType === "void") return undefined as T;
  if (responseType === "text") return (await response.text()) as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "The server sent a response that could not be read.");
  }
}

function queryString(query: Record<string, string | number | boolean>): string {
  const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** The services answer an error with Dropwizard's {code, message}, a bare {message}, plain text, or nothing. */
async function errorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("json")) {
    const error = (await response.json().catch(() => null)) as { message?: unknown } | null;
    if (typeof error?.message === "string" && error.message) return error.message;
  } else if (contentType.startsWith("text/plain")) {
    const text = (await response.text()).trim();
    if (text) return text;
  }
  return `The server returned an error (${response.status}).`;
}
