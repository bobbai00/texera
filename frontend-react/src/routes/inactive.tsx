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
import { InactivePage } from "@/features/auth/components/inactive-page";
import { getSession, isActive } from "@/lib/session";

// New accounts start inactive, and every dataset call answers them 403 until an administrator
// activates the account and the user signs in again (the role is in the token).
export const Route = createFileRoute("/inactive")({
  beforeLoad: () => {
    const session = getSession();
    if (!session) throw redirect({ to: "/sign-in" });
    if (isActive(session)) throw redirect({ to: "/datasets" });
  },
  component: InactivePage,
});
