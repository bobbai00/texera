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
import type { ResourcePath } from "@/lib/resource-path";
import { operator, schemaOf } from "@/testing/workflow";
import type { Operator } from "./model";
import type { OperatorSchema } from "./operator-schema";
import { keptParameters, resourcesOf } from "./resources";

/** A parameter of a UDF as it is kept, given a version of a resource when its input type says so. */
const parameter = (attributeName: string, value: string, inputType?: unknown) => ({
  attribute: { attributeName, attributeType: "string" },
  value,
  ...(inputType !== undefined && { inputType }),
});

/** A type whose settings name a version as a whole and a file, as FileLister's and the scans' do, and other text. */
const lister: OperatorSchema = {
  ...schemaOf("Limit"),
  operatorType: "Lister",
  jsonSchema: {
    properties: {
      datasetVersionPath: { type: "string", propertyOrder: 1 },
      keyword: { type: "string", propertyOrder: 2 },
      fromUrl: { type: "boolean", propertyOrder: 3 },
      fileName: {
        type: "string",
        propertyOrder: 4,
        hideTarget: "fromUrl",
        hideType: "equals",
        hideExpectedValue: "true",
      },
    },
  },
};
const listing = (properties: Record<string, unknown>): Operator => ({
  ...operator("Limit", "lister"),
  operatorProperties: properties,
});

const scanOf = (fileName: unknown) =>
  resourcesOf(operator("CSVFileScan", "scan", { fileName }), schemaOf("CSVFileScan"));
const listerOf = (datasetVersionPath: string) => resourcesOf(listing({ datasetVersionPath }), lister);
const udfOf = (...uiParameters: unknown[]) =>
  resourcesOf(operator("PythonUDFV2", "udf", { uiParameters }), schemaOf("PythonUDFV2"));

const penguins = { kind: "dataset", owner: "texera", name: "penguins", version: "v1" } as const;
const resnet = { kind: "model", owner: "texera", name: "resnet", version: "v3" } as const;

describe("resourcesOf", () => {
  // What the server reads in a path, by the kind of setting that holds it: a scan reads a file (FileResolver), a
  // lister lists a version of a dataset (LakeFSDatasetVersionLister), and a parameter takes a version as a whole
  // (FileResolver.resolveRepositoryVersion).
  it.each<[string, () => ResourcePath[], ResourcePath[]]>([
    [
      "the version of a dataset whose file a scan reads, with the file",
      () => scanOf("/dataset/texera/penguins/v2 - by island/islands/biscoe.csv"),
      [{ ...penguins, version: "v2 - by island", file: "islands/biscoe.csv" }],
    ],
    [
      "the version of a model whose file a scan reads",
      () => scanOf("/model/texera/resnet/v3/labels.csv"),
      [{ ...resnet, file: "labels.csv" }],
    ],
    [
      "no version where a scan is given one as a whole, which names no file",
      () => scanOf("/dataset/texera/penguins/v1"),
      [],
    ],
    ["the version of a dataset that a lister lists", () => listerOf("/dataset/texera/penguins/v1"), [penguins]],
    [
      "the version a lister lists of the path of a file, which it reads as far as the version",
      () => listerOf("/dataset/texera/penguins/v1/adelie.csv"),
      [penguins],
    ],
    [
      "the version of a dataset without the prefix that a lister lists",
      () => listerOf("/texera/penguins/v1"),
      [penguins],
    ],
    [
      "no version where a lister is given a model's, which lists no model",
      () => listerOf("/model/texera/resnet/v3"),
      [],
    ],
    [
      "the version of a model that a parameter takes",
      () => udfOf(parameter("weights", "/model/texera/resnet/v3", "model")),
      [resnet],
    ],
    [
      "no version where a parameter is given the path of a file, which it does not take",
      () => udfOf(parameter("weights", "/model/texera/resnet/v3/weights.pt", "model")),
      [],
    ],
    [
      "no version where a parameter's input type names no kind of resource exactly",
      () =>
        udfOf(
          parameter("key", "/dataset/texera/penguins/v1", "credential"),
          parameter("set", "/dataset/texera/penguins/v1", true),
          parameter("upper", "/dataset/texera/penguins/v1", "DATASET")
        ),
      [],
    ],
  ])("names %s", (_, resources, named) => {
    expect(resources()).toEqual(named);
  });

  it("names nothing for a file that no path names, for a setting that holds no text, or for an operator that reads none", () => {
    expect(scanOf("penguins.csv")).toEqual([]);
    expect(scanOf("https://example.com/texera/penguins/v1/adelie.csv")).toEqual([]);
    expect(scanOf(42)).toEqual([]);
    expect(resourcesOf(operator("CSVFileScan", "scan"), schemaOf("CSVFileScan"))).toEqual([]);
    expect(resourcesOf(operator("Limit", "limit", { limit: 5 }), schemaOf("Limit"))).toEqual([]);
  });

  it("names the versions that a UDF's parameters take, each once, in the order of the parameters", () => {
    expect(
      udfOf(
        parameter("weights", "/model/texera/resnet/v3", "model"),
        parameter("train", "/dataset/texera/penguins/v1", "dataset"),
        parameter("again", "/model/texera/resnet/v3", "model"),
        // Free text, as the backend keeps it, and a parameter its code gives no input type: neither is a version.
        parameter("note", "/dataset/texera/penguins/v2", ""),
        parameter("plain", "/dataset/texera/penguins/v3"),
        // A version that is not chosen yet.
        parameter("test", "", "dataset")
      )
    ).toEqual([resnet, penguins]);
  });

  it("passes over parameters that are not kept as parameters are", () => {
    expect(resourcesOf(operator("PythonUDFV2", "udf", { uiParameters: "weights" }), schemaOf("PythonUDFV2"))).toEqual(
      []
    );
    expect(udfOf(null, "weights", { inputType: "model" }, { inputType: "model", value: 3 })).toEqual([]);
  });

  it("follows the order of the settings, reads only the settings that hold paths, and none that is hidden", () => {
    expect(
      resourcesOf(
        listing({
          fileName: "/dataset/texera/penguins/v1/adelie.csv",
          keyword: "/dataset/texera/flowers/v1",
          datasetVersionPath: "/dataset/texera/iris/v2",
        }),
        lister
      )
    ).toEqual([
      { kind: "dataset", owner: "texera", name: "iris", version: "v2" },
      { ...penguins, file: "adelie.csv" },
    ]);
    expect(resourcesOf(listing({ fromUrl: true, fileName: "/dataset/texera/penguins/v1/adelie.csv" }), lister)).toEqual(
      []
    );
  });

  it("names a version once, with the file that the first setting to name it names", () => {
    expect(
      resourcesOf(
        listing({
          datasetVersionPath: "/dataset/texera/penguins/v1",
          fileName: "/dataset/texera/penguins/v1/adelie.csv",
        }),
        lister
      )
    ).toEqual([penguins]);
  });
});

describe("keptParameters", () => {
  it("reads each parameter that is kept as one is, taking a version where its input type names a kind exactly", () => {
    expect(
      keptParameters([
        parameter("count", "5"),
        parameter("weights", "/model/texera/resnet/v3", "model"),
        parameter("train", "", "dataset"),
        parameter("key", "/dataset/texera/penguins/v1", "credential"),
        parameter("set", "/dataset/texera/penguins/v1", true),
      ])
    ).toEqual([
      parameter("count", "5"),
      parameter("weights", "/model/texera/resnet/v3", "model"),
      parameter("train", "", "dataset"),
      parameter("key", "/dataset/texera/penguins/v1"),
      parameter("set", "/dataset/texera/penguins/v1"),
    ]);
  });

  it.each<[string, unknown]>([
    ["no list", "weights"],
    ["nothing", undefined],
    ["entries that are not parameters", [null, 3, "weights", { value: "5" }]],
    ["a parameter without a name", [parameter("", "5")]],
    [
      "a parameter whose value is no text",
      [{ attribute: { attributeName: "count", attributeType: "integer" }, value: 5 }],
    ],
  ])("reads no parameter of %s", (_, parameters) => {
    expect(keptParameters(parameters)).toEqual([]);
  });
});
