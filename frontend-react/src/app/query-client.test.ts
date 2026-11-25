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
import { ApiError } from "@/lib/api-client";
import { createQueryClient } from "./query-client";

/** Runs a query whose every try fails with this error, and counts the tries. */
async function triesFor(error: Error): Promise<number> {
  const queryFn = vi.fn().mockRejectedValue(error);
  // No wait between tries, so the test does not take seconds.
  await createQueryClient()
    .fetchQuery({ queryKey: ["datasets"], queryFn, retryDelay: 0 })
    .catch(() => undefined);
  return queryFn.mock.calls.length;
}

describe("createQueryClient", () => {
  it("tries a server error three times in all", async () => {
    expect(await triesFor(new ApiError(503, "Service Unavailable"))).toBe(3);
  });

  it("tries again when no response came", async () => {
    expect(await triesFor(new ApiError(0, "Could not reach the server."))).toBe(3);
  });

  it.each([400, 401, 403, 404, 409])("does not try a %d again", async status => {
    expect(await triesFor(new ApiError(status, "Refused"))).toBe(1);
  });

  it("does not try a bug again", async () => {
    expect(await triesFor(new TypeError("undefined is not a function"))).toBe(1);
  });
});
