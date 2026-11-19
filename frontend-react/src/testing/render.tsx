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

import { createMemoryHistory, RouterContextProvider, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createQueryClient } from "@/app/query-client";
import { createAppRouter } from "@/app/router";
import type { Session } from "@/lib/session";

/**
 * Opens the whole app at a URL, such as "/datasets", as a user would: the real routes, guards and
 * pages, with the fake backend behind them. Given a session, the user is signed in.
 */
export function renderApp(url: string, { session }: { session?: Session } = {}) {
  const { queryClient, router } = createTestApp(url, session);
  return { user: userEvent.setup(), queryClient, router, ...render(<RouterProvider router={router} />) };
}

/**
 * Renders one component with what every page has around it: the query cache, and the router for links.
 * Given a session, the user is signed in.
 */
export function renderWithProviders(ui: ReactElement, { session }: { session?: Session } = {}) {
  const { queryClient, router } = createTestApp("/", session);
  return {
    user: userEvent.setup(),
    queryClient,
    router,
    ...render(<RouterContextProvider router={router}>{ui}</RouterContextProvider>),
  };
}

function createTestApp(url: string, session?: Session) {
  if (session) localStorage.setItem("access_token", session.token);
  const queryClient = createQueryClient();
  // The app's retry rule, with no wait between tries, so a test of a failing call stays fast.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [url] }) });
  return { queryClient, router };
}
