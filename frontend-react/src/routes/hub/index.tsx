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

import { createFileRoute } from "@tanstack/react-router";
import type { SearchableKind } from "@/components/resource/api";
import { HubPage } from "@/features/hub/components/hub-page";

const kinds: SearchableKind[] = ["workflow", "dataset", "model"];

export const Route = createFileRoute("/hub/")({
  // The kind of public resources shown: ?kind=dataset. Workflows, without one.
  validateSearch: ({ kind }: Record<string, unknown>): { kind: SearchableKind } => ({
    kind: kinds.find(each => each === kind) ?? "workflow",
  }),
  component: HubRoute,
});

function HubRoute() {
  const { kind } = Route.useSearch();
  // Another kind is another list: nothing of one may show in the next.
  return (
    <HubPage
      key={kind}
      kind={kind}
    />
  );
}
