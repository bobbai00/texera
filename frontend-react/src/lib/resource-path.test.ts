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
import { parseResourcePath, type ResourcePath, resourcePath } from "./resource-path";

const penguins = { kind: "dataset", owner: "ada@uci.edu", name: "penguins", version: "v1" } as const;

/** What the server reads in each value (FileResolver.parsePrefixedPath), and undefined where it reads no path. */
const paths: [string, string, ResourcePath | undefined][] = [
  [
    "a file of a version of a dataset",
    "/dataset/ada@uci.edu/penguins/v1/adelie.csv",
    { ...penguins, file: "adelie.csv" },
  ],
  ["a version of a dataset", "/dataset/ada@uci.edu/penguins/v1", penguins],
  [
    "a file in a folder of a version of a model",
    "/model/ada@uci.edu/resnet/v3/weights/model.pt",
    { kind: "model", owner: "ada@uci.edu", name: "resnet", version: "v3", file: "weights/model.pt" },
  ],
  [
    "a version of a model",
    "/model/ada@uci.edu/resnet/v3",
    { kind: "model", owner: "ada@uci.edu", name: "resnet", version: "v3" },
  ],
  [
    "a version named for what it holds, of an owner whose email has no @",
    "/dataset/texera/penguins/v2 - by island/islands/biscoe.csv",
    { kind: "dataset", owner: "texera", name: "penguins", version: "v2 - by island", file: "islands/biscoe.csv" },
  ],
  [
    "a dataset named dataset, with a folder named dataset",
    "/dataset/texera/dataset/v1/dataset/adelie.csv",
    { kind: "dataset", owner: "texera", name: "dataset", version: "v1", file: "dataset/adelie.csv" },
  ],
  ["a model named model", "/model/texera/model/v1", { kind: "model", owner: "texera", name: "model", version: "v1" }],
  [
    "a path with repeated and trailing slashes",
    "//dataset//ada@uci.edu/penguins///v1/adelie.csv/",
    { ...penguins, file: "adelie.csv" },
  ],
  ["a path without its first slash", "dataset/ada@uci.edu/penguins/v1", penguins],
  ["a path with spaces around it", "  /dataset/ada@uci.edu/penguins/v1\n", penguins],
  [
    "a path with dots, which stay segments as any others",
    "/dataset/texera/../penguins/v1",
    { kind: "dataset", owner: "texera", name: "..", version: "penguins", file: "v1" },
  ],
  [
    "a file of a dataset without the prefix, as paths were written before",
    "/ada@uci.edu/penguins/v1/adelie.csv",
    { ...penguins, file: "adelie.csv" },
  ],
  ["a version of a dataset without the prefix", "/ada@uci.edu/penguins/v1", penguins],
  [
    "the plural prefix of a migration since undone, as a path without a prefix",
    "/datasets/texera/penguins/v1/adelie.csv",
    { kind: "dataset", owner: "datasets", name: "texera", version: "penguins", file: "v1/adelie.csv" },
  ],
  [
    "a prefix in capitals, as a path without a prefix",
    "/Dataset/texera/penguins/v1",
    { kind: "dataset", owner: "Dataset", name: "texera", version: "penguins", file: "v1" },
  ],
  ["a drive letter, which is no scheme", "C:/x/y.txt", { kind: "dataset", owner: "C:", name: "x", version: "y.txt" }],
  ["a dataset without a version as no path", "/dataset/ada@uci.edu/penguins", undefined],
  ["a model without a version as no path", "/model/ada@uci.edu/resnet", undefined],
  ["a dataset without a prefix and a version as no path", "/ada@uci.edu/penguins", undefined],
  ["a file's name alone as no path", "penguins.csv", undefined],
  ["the root as no path", "/", undefined],
  ["nothing as no path", "", undefined],
  ["spaces as no path", "   ", undefined],
  ["a web address as no path", "https://example.com/ada/penguins/v1/adelie.csv", undefined],
  ["a dataset's file that was found already as no path", "dataset:///dataset-15/adeq233td/dir/f.csv", undefined],
  ["a local file as no path", "file:///tmp/ada/penguins/v1.csv", undefined],
  ["an address whose scheme has a digit as no path", "s3://bucket/ada/penguins/v1", undefined],
];

describe("parseResourcePath", () => {
  it.each(paths)("reads %s", (_, value, path) => {
    expect(parseResourcePath(value)).toEqual(path);
  });
});

describe("resourcePath", () => {
  it("writes the path of a file in a version, and of a version as a whole", () => {
    expect(
      resourcePath({
        kind: "dataset",
        owner: "texera",
        name: "penguins",
        version: "v2 - by island",
        file: "islands/biscoe.csv",
      })
    ).toBe("/dataset/texera/penguins/v2 - by island/islands/biscoe.csv");
    expect(resourcePath({ kind: "model", owner: "ada@uci.edu", name: "resnet", version: "v3" })).toBe(
      "/model/ada@uci.edu/resnet/v3"
    );
  });

  it("writes a path without a prefix with the one that stored paths have now", () => {
    expect(resourcePath(parseResourcePath("/ada@uci.edu/penguins/v1/adelie.csv")!)).toBe(
      "/dataset/ada@uci.edu/penguins/v1/adelie.csv"
    );
  });

  it.each(paths.filter(([, , path]) => path !== undefined))("writes a path that reads back as %s", (_, __, path) => {
    expect(parseResourcePath(resourcePath(path!))).toEqual(path);
  });
});
