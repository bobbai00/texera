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

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { RouterProvider } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "@/app/query-client";
import { createAppRouter } from "@/app/router";
import { applyTheme, preferredTheme } from "@/lib/theme";
import "@/styles/globals.css";

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });
applyTheme(preferredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    {/* Asked for with VITE_DEVTOOLS=1 yarn dev: their buttons sit over the corners of the app. */}
    {import.meta.env.DEV && import.meta.env.VITE_DEVTOOLS === "1" && (
      <>
        <ReactQueryDevtools client={queryClient} />
        <TanStackRouterDevtools router={router} />
      </>
    )}
  </StrictMode>
);
