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

import type { Preview } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterContextProvider } from "@tanstack/react-router";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { createAppRouter } from "@/app/router";
import { applyTheme, type Theme } from "@/lib/theme";
import "@/styles/globals.css";

/**
 * Gives a story what a page has around it: the theme from the toolbar, a router for its links, and a
 * query cache of its own. A story that shows server data puts the data in that cache, with
 * useQueryClient().setQueryData in a decorator, so it never calls the network.
 */
function StoryProviders({ theme, children }: { theme: Theme; children: ReactNode }) {
  const [router] = useState(() =>
    createAppRouter({
      // Data a story put in the cache never goes stale, so nothing is fetched.
      queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }),
      history: createMemoryHistory(),
    })
  );
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Light or dark theme",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, { globals }) => (
      <StoryProviders theme={globals.theme === "dark" ? "dark" : "light"}>
        <Story />
      </StoryProviders>
    ),
  ],
};

export default preview;
