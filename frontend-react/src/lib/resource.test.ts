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
import { type AccessLevel, can, type ResourceAction, toAccessLevel } from "./resource";

describe("toAccessLevel", () => {
  it.each([
    [{ isOwner: true, privilege: "WRITE", isPublic: false }, "owner"],
    [{ isOwner: true, privilege: "NONE", isPublic: false }, "owner"],
    [{ isOwner: false, privilege: "WRITE", isPublic: false }, "edit"],
    [{ isOwner: false, privilege: "READ", isPublic: false }, "view"],
    [{ isOwner: false, privilege: "NONE", isPublic: true }, "view"],
    [{ isOwner: false, privilege: "WRITE", isPublic: true }, "edit"],
    [{ isOwner: false, privilege: "NONE", isPublic: false }, "none"],
  ] as const)("reads %j as %j", (answer, level) => {
    expect(toAccessLevel(answer)).toBe(level);
  });
});

describe("can", () => {
  const allowed: Record<AccessLevel, ResourceAction[]> = {
    none: [],
    view: ["view"],
    edit: ["view", "edit", "share"],
    owner: ["view", "edit", "share", "delete"],
  };

  it.each(Object.entries(allowed) as [AccessLevel, ResourceAction[]][])(
    "lets a user with the access %j do exactly %j",
    (access, actions) => {
      const all: ResourceAction[] = ["view", "edit", "share", "delete"];

      expect(all.filter(action => can({ access }, action))).toEqual(actions);
    }
  );
});
