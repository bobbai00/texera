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

import { createFileRoute, redirect } from "@tanstack/react-router";
import { SignInPage } from "@/features/auth/components/sign-in-page";
import { getSession } from "@/lib/session";

interface SignInSearch {
  /** The page to open after signing in, such as "/datasets/12". */
  redirect?: string;
}

export const Route = createFileRoute("/sign-in")({
  validateSearch: ({ redirect }: Record<string, unknown>): SignInSearch => ({
    redirect: typeof redirect === "string" ? pathOnThisSite(redirect) : undefined,
  }),
  // A signed-in user goes on at once. This runs again right after signing in (see __root.tsx).
  beforeLoad: ({ search }) => {
    if (getSession()) throw redirect({ href: search.redirect ?? "/datasets" });
  },
  component: SignInPage,
});

/**
 * The path of a URL on this site, or undefined for any other site's, which would make this page an open redirect.
 * The URL is read as the browser reads it, so a tab or a newline cannot hide another site in it.
 */
function pathOnThisSite(url: string): string | undefined {
  const { origin } = window.location;
  const parsed = URL.parse(url, origin);
  return parsed?.origin === origin ? parsed.pathname + parsed.search + parsed.hash : undefined;
}
