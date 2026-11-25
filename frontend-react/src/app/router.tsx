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

import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PagePending } from "@/components/layout/page";
import { routeTree } from "@/routeTree.gen";

/** What every route's guard and loader receive. */
export interface RouterContext {
  queryClient: QueryClient;
}

/** The app's router. Tests and stories pass a memory history instead of the browser's. */
export function createAppRouter({ queryClient, history }: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    history,
    // "/alpha/" while the Angular app keeps "/".
    basepath: import.meta.env.BASE_URL,
    context: { queryClient },
    // Everything the router renders, including a test's or a story's component, reads the same cache.
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    // A page whose data cannot be loaded says why, where the page would be.
    defaultErrorComponent: ({ error }) => (
      <Page>
        <ErrorAlert error={error instanceof Error ? error : String(error)} />
      </Page>
    ),
    // A page whose data takes long shows its outline meanwhile.
    defaultPendingComponent: PagePending,
    defaultPreload: "intent",
    // React Query decides whether cached data is fresh, so the router always runs the loaders.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
