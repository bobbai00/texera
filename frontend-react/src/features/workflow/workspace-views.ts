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

import { HistoryIcon, ListChecksIcon, type LucideIcon, ShapesIcon, SlidersHorizontalIcon } from "lucide-react";

/** What the workflow's workspace panel shows, one at a time, in the order its rail has until the user changes it. */
export const workspaceViews = {
  operators: { title: "Operators", icon: ShapesIcon },
  versions: { title: "Versions", icon: HistoryIcon },
  executions: { title: "Executions", icon: ListChecksIcon },
  settings: { title: "Settings", icon: SlidersHorizontalIcon },
} satisfies Record<string, { title: string; icon: LucideIcon }>;

export type WorkspaceView = keyof typeof workspaceViews;

const everyView = Object.keys(workspaceViews) as WorkspaceView[];

function isWorkspaceView(kept: unknown): kept is WorkspaceView {
  return typeof kept === "string" && kept in workspaceViews;
}

/** The view the browser kept, if it is one; the operators otherwise. */
export function workspaceViewOf(kept: unknown): WorkspaceView {
  return isWorkspaceView(kept) ? kept : "operators";
}

/**
 * Every view in the order the user put them in, from what the browser kept: what is not a view is left out, and a
 * view it does not name, such as one added since, follows the others in its own place.
 */
export function workspaceOrderOf(kept: unknown): WorkspaceView[] {
  const named = [...new Set(Array.isArray(kept) ? kept.filter(isWorkspaceView) : [])];
  return [...named, ...everyView.filter(view => !named.includes(view))];
}

/**
 * The order of every view, once the user put the views they see in a new one. A view they do not see, such as the
 * operators of a workflow they may only view, keeps its place among the others.
 */
export function reordered(order: WorkspaceView[], seen: WorkspaceView[]): WorkspaceView[] {
  const next = seen.values();
  return order.map(view => (seen.includes(view) ? next.next().value! : view));
}
