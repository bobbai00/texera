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

import { useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import type { RouterContext } from "@/app/router";
import { getSession, publicKey, subscribe } from "@/lib/session";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  const router = useRouter();
  const queryClient = useQueryClient();

  // The session changes on sign-in and sign-out, when the server rejects the token, and when another
  // tab or the Angular app signs in or out. Forget the data of the last user, and run the route
  // guards again: they send the user to the page that fits the new session.
  useEffect(() => {
    function onSessionChange() {
      queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== publicKey[0] });
      void router.invalidate();
    }
    const unsubscribe = subscribe(onSessionChange);
    // The server may have rejected the token while the first page loaded, before this listened.
    if (!getSession()) onSessionChange();
    return unsubscribe;
  }, [router, queryClient]);

  return <Outlet />;
}

/** An address that is no page. People type the Angular app's addresses here too, so it offers that app as well. */
function NotFound() {
  return (
    <main className="space-y-2 p-6">
      <p>This page does not exist.</p>
      <p>
        Go back to the{" "}
        <Link
          to="/datasets"
          className="underline">
          datasets
        </Link>
        , or to{" "}
        <a
          href="/"
          className="underline">
          Texera's home page
        </a>
        .
      </p>
    </main>
  );
}
