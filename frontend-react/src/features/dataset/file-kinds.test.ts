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
import { fileKindOf } from "./file-kinds";

describe("the kind of a file", () => {
  it.each([
    ["penguins.csv", { kind: "table" }],
    ["penguins.tsv", { kind: "table" }],
    ["budget.xlsx", { kind: "spreadsheet" }],
    ["model.json", { kind: "text", language: "json", wrap: false }],
    ["analysis.ipynb", { kind: "text", language: "json", wrap: false }],
    ["README.md", { kind: "markdown" }],
    ["report.html", { kind: "html" }],
    ["notes.txt", { kind: "text", language: "text", wrap: true }],
    ["clean.py", { kind: "text", language: "python", wrap: false }],
    ["query.sql", { kind: "text", language: "sql", wrap: false }],
    ["config.yml", { kind: "text", language: "yaml", wrap: false }],
    ["photo.jpeg", { kind: "image" }],
    ["paper.pdf", { kind: "pdf" }],
    ["talk.mp4", { kind: "video" }],
    ["song.mp3", { kind: "audio" }],
    ["penguins.parquet", { kind: "binary" }],
    ["archive.zip", { kind: "binary" }],
  ])("of %s is told by its extension", (name, kind) => {
    expect(fileKindOf(name)).toEqual(kind);
  });

  it("is told whatever the case of the extension", () => {
    expect(fileKindOf("PENGUINS.CSV")).toEqual({ kind: "table" });
    expect(fileKindOf("Photo.JPG")).toEqual({ kind: "image" });
  });

  it("is the last extension's, and the whole name's when it starts with its only dot", () => {
    expect(fileKindOf("penguins.csv.gz")).toEqual({ kind: "binary" });
    expect(fileKindOf(".env")).toEqual({ kind: "text", language: "properties", wrap: false });
  });

  it("is not known of a file without an extension, or with one the app does not know", () => {
    expect(fileKindOf("LICENSE")).toEqual({ kind: "unknown" });
    expect(fileKindOf("data.weird")).toEqual({ kind: "unknown" });
  });
});
