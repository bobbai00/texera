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

import { useStoredState } from "@/components/use-stored-state";
import { reordered, type WorkspaceView, workspaceOrderOf, workspaceViewOf } from "./workspace-views";

/**
 * The workspace panel's views as the user arranged them: the one shown, and their order in its rail, both kept in
 * the browser. `available` are the views the user has here: there are no operators to add to a version.
 */
export function useWorkspaceViews(available: WorkspaceView[]) {
  const [chosen, choose] = useStoredState("texera.workflowWorkspace", workspaceViewOf);
  const [order, setOrder] = useStoredState("texera.workflowWorkspace.order", workspaceOrderOf);
  const views = order.filter(view => available.includes(view));
  return {
    /** The views of the rail, in the user's order. */
    views,
    /** The view shown: the one the user chose, or else the first of the rail. */
    view: views.includes(chosen) ? chosen : views[0],
    choose,
    /** Puts the views of the rail in this order. */
    reorder: (seen: WorkspaceView[]) => setOrder(current => reordered(current, seen)),
  };
}
