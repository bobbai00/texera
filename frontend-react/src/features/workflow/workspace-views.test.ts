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

import { describe, expect, it } from "vitest";
import { reordered, workspaceOrderOf, workspaceViewOf } from "./workspace-views";

describe("the views of the workspace panel", () => {
  it("are shown as the browser kept them, or start on the operators", () => {
    expect(workspaceViewOf("versions")).toBe("versions");
    expect(workspaceViewOf("history")).toBe("operators");
    expect(workspaceViewOf(undefined)).toBe("operators");
  });

  it("are in the order the browser kept, with what it does not name after, in their own order", () => {
    expect(workspaceOrderOf(["settings", "versions", "operators", "executions"])).toEqual([
      "settings",
      "versions",
      "operators",
      "executions",
    ]);
    expect(workspaceOrderOf(["settings"])).toEqual(["settings", "operators", "versions", "executions"]);
  });

  it("are in their own order when the browser kept nothing it can use", () => {
    const own = ["operators", "versions", "executions", "settings"];
    expect(workspaceOrderOf(undefined)).toEqual(own);
    expect(workspaceOrderOf("versions")).toEqual(own);
    expect(workspaceOrderOf(["history", 3, null, "versions", "versions"])).toEqual([
      "versions",
      ...own.filter(view => view !== "versions"),
    ]);
  });

  it("keep the place of a view the user does not see when they put the others in a new order", () => {
    const order = workspaceOrderOf(undefined);
    expect(reordered(order, ["settings", "versions", "executions"])).toEqual([
      "operators",
      "settings",
      "versions",
      "executions",
    ]);
    expect(reordered(["versions", "operators", "settings", "executions"], ["settings", "versions"])).toEqual([
      "settings",
      "operators",
      "versions",
      "executions",
    ]);
  });
});
