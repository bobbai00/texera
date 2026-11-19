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
import { delimiterPresets, delimiterProblem } from "./delimiter";

describe("delimiters", () => {
  it("offers a tab as the character it is where a file is read, and as its expression where a text is split", () => {
    const tab = (mode: "char" | "regex") => delimiterPresets[mode].find(preset => preset.label === "Tab")?.value;

    expect(tab("char")).toBe("\t");
    expect(tab("regex")).toBe("\\t");
  });

  it("finds nothing wrong with any delimiter it offers", () => {
    for (const mode of ["char", "regex"] as const) {
      for (const { value } of delimiterPresets[mode]) expect(delimiterProblem(value, mode)).toBeUndefined();
    }
  });

  it.each([
    ["", "char", undefined],
    ["||", "char", "A delimiter here is a single character."],
    ["[,;]\\s*", "regex", undefined],
    ["[,", "regex", "This is not a regular expression."],
    [",*", "regex", "This expression matches an empty text, so it would split everywhere."],
  ] as const)("says of %j as a %s delimiter: %s", (value, mode, problem) => {
    expect(delimiterProblem(value, mode)).toBe(problem);
  });
});
