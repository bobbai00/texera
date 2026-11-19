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

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useSession } from "@/app/use-session";
import { getSession, isActive } from "@/lib/session";

// Every page under this route needs an active account.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: ({ location }) => {
    const session = getSession();
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    if (!isActive(session)) throw redirect({ to: "/inactive" });
  },
  component: SignedIn,
});

function SignedIn() {
  const session = useSession();
  // The session has just ended, and the guard is on its way to the sign-in page (see __root.tsx).
  if (!session) return null;
  // When another tab signs in as someone else, the page starts afresh, without the last user's work.
  return <Outlet key={session.userId} />;
}
