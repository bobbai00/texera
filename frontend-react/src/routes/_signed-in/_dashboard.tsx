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

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { navigationFor } from "@/app/navigation";
import { useSession } from "@/app/use-session";
import { Shell } from "@/components/layout/shell";
import { publicSettingsQuery } from "@/components/settings/api";

// The pages of the dashboard: each is shown in the shell, with the header and the navigation, which shows the
// areas that the settings leave on.
export const Route = createFileRoute("/_signed-in/_dashboard")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(publicSettingsQuery()),
  component: Dashboard,
});

function Dashboard() {
  const session = useSession();
  const { data: settings } = useSuspenseQuery(publicSettingsQuery());
  if (!session) return null;
  return (
    <Shell
      user={session}
      navigation={navigationFor(session, settings)}>
      <Outlet />
    </Shell>
  );
}
