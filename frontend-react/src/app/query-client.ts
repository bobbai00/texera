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

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";

/** The cache of server data that every page reads through. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data a page has just loaded is not loaded again for 30 seconds.
        staleTime: 30_000,
        // Try again, at most twice, only what may pass on another try: no response, or a server error.
        retry: (failureCount, error) =>
          failureCount < 2 && error instanceof ApiError && (error.status === 0 || error.status >= 500),
      },
    },
  });
}
