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
import { link, operator, workflowContent } from "@/testing/workflow";
import { inputSchemas, readableError, readCompilation } from "./compilation";

const text = (attributeName: string) => ({ attributeName, attributeType: "string" });

describe("readCompilation", () => {
  it("reads what each operator puts out, port by port", () => {
    const compilation = readCompilation({
      operatorOutputSchemas: { scan: { "0_false": [text("species")] }, join: { "0_false": null } },
    });

    expect(compilation.outputSchemas).toEqual({ scan: [[text("species")]], join: [undefined] });
    expect(compilation.errors).toEqual({});
  });

  it("says in plain words why an operator does not compile", () => {
    const compilation = readCompilation({
      operatorErrors: {
        filter: {
          message: "java.lang.RuntimeException: Operator is not configured properly: requirement failed: no predicate",
        },
        join: { message: "", details: "scala.MatchError: null" },
      },
    });

    expect(compilation.errors).toEqual({ filter: "No predicate", join: "Some settings are missing or not valid." });
  });
});

describe("inputSchemas", () => {
  const { links } = workflowContent(
    [operator("CSVFileScan", "scan"), operator("Filter", "filter"), operator("HashJoin", "join")],
    [link("scan", "filter"), link("scan", "join", 0), link("filter", "join", 1)]
  );

  it("gives each operator the columns that the operators before it put out, port by port", () => {
    const arriving = inputSchemas(links, {
      scan: [[text("species")]],
      filter: [[text("species"), text("island")]],
    });

    expect(arriving.filter).toEqual([[text("species")]]);
    expect(arriving.join).toEqual([[text("species")], [text("species"), text("island")]]);
    expect(arriving.scan).toBeUndefined();
  });

  it("tells an operator that does not compile what arrives at it, and leaves unknown what no one puts out", () => {
    // The filter is not complete, so the service was not asked about it: it has no output, but it has an input.
    const arriving = inputSchemas(links, { scan: [[text("species")]] });

    expect(arriving.filter).toEqual([[text("species")]]);
    expect(arriving.join).toEqual([[text("species")], undefined]);
  });
});

describe("readableError", () => {
  it.each([
    ["java.lang.IllegalArgumentException: column x not found", "Column x not found"],
    ["Each sort key must have an attribute selected.", "Each sort key must have an attribute selected."],
    ["java.lang.NullPointerException", "Some settings are missing or not valid."],
    ["", "Some settings are missing or not valid."],
  ])("reads %j as %j", (message, readable) => {
    expect(readableError(message)).toBe(readable);
  });
});
