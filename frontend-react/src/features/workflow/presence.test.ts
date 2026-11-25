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

import { describe, expect, expectTypeOf, it } from "vitest";
import { editingNotice, editingParts, presenceClassNames } from "./presence";

describe("presenceClassNames", () => {
  it("gives each of the six colors its own label, text and edge", () => {
    expect(presenceClassNames({ color: 1 })).toEqual({
      label: "bg-presence-1 text-white",
      text: "text-presence-1",
      border: "border-presence-1",
    });
    expect(presenceClassNames({ color: 6 }).border).toBe("border-presence-6");
  });

  it("writes every label in white on its color, as the colors are made for", () => {
    for (const color of [1, 2, 3, 4, 5, 6]) {
      expect(presenceClassNames({ color }).label).toBe(`bg-presence-${color} text-white`);
    }
  });
});

describe("editingNotice", () => {
  it("says who is editing what someone else holds", () => {
    expect(editingNotice([{ name: "Grace" }])).toBe("Grace is editing");
  });

  it("names everyone who is editing, each once", () => {
    expect(editingNotice([{ name: "Grace" }, { name: "Alan" }])).toBe("Grace and Alan are editing");
    expect(editingNotice([{ name: "Grace" }, { name: "Alan" }, { name: "Ada" }])).toBe(
      "Grace, Alan, and Ada are editing"
    );
    // Two tabs of one person are two people in the room, but one name.
    expect(editingNotice([{ name: "Grace" }, { name: "Grace" }])).toBe("Grace is editing");
  });

  it("calls someone who has no name, as a browser of another version may tell it, someone", () => {
    expect(editingNotice([{ name: "" }])).toBe("Someone is editing");
    expect(editingNotice([{ name: "  " }, { name: "Grace" }])).toBe("Someone and Grace are editing");
  });

  it("is said of at least one person: there is no notice of nobody", () => {
    // Checked as the code is type-checked: no list of nobody may be given.
    expectTypeOf<[]>().not.toExtend<Parameters<typeof editingNotice>[0]>();
    expectTypeOf<[{ name: string }]>().toExtend<Parameters<typeof editingNotice>[0]>();
  });
});

describe("editingParts", () => {
  it("parts who is editing from what they do, so that a label short of room cuts the names, not the verb", () => {
    expect(editingParts([{ name: "Grace" }])).toEqual(["Grace", "is editing"]);
    expect(editingParts([{ name: "Grace" }, { name: "Alan" }])).toEqual(["Grace and Alan", "are editing"]);
  });
});
