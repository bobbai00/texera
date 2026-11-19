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
import { declaredParameters, parameterDeclaration, type UdfParameter } from "./udf-parameters";

const udf = (open: string) => `from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def open(self) -> None:
${open
  .split("\n")
  .map(line => `        ${line}`)
  .join("\n")}

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        yield tuple_
`;

const parameter = (attributeName: string, attributeType: UdfParameter["attribute"]["attributeType"], value = "") => ({
  attribute: { attributeName, attributeType },
  value,
});

describe("declaredParameters", () => {
  it("finds each parameter the UDF class declares, by its name and type, in either way of writing them", () => {
    const code = udf(`self.count = self.UiParameter("count", AttributeType.INT).value
self.rate = self.UiParameter(name='rate', type=AttributeType.DOUBLE).value
self.on = self.UiParameter("on", attr_type=AttributeType.BOOLEAN).value`);

    expect(declaredParameters(code, [])).toEqual({
      parameters: [parameter("count", "integer"), parameter("rate", "double"), parameter("on", "boolean")],
    });
  });

  it("keeps the value a parameter had, while it keeps its name and kind", () => {
    const code = udf(`self.count = self.UiParameter("count", AttributeType.LONG).value
self.path = self.UiParameter("path", AttributeType.STRING, value=Resource.DATASET).value`);
    const current: UdfParameter[] = [
      parameter("count", "integer", "10"),
      { ...parameter("path", "string", "/dataset/a@b.c/penguins/v1"), inputType: "model" },
      parameter("gone", "string", "x"),
    ];

    expect(declaredParameters(code, current)).toEqual({
      parameters: [
        // A change of type keeps the value: the user may still mean it.
        parameter("count", "long", "10"),
        // A model's path is no dataset's: the value goes.
        { ...parameter("path", "string"), inputType: "dataset" },
      ],
    });
  });

  it("finds nothing in code without a UDF class, in comments, or in calls it cannot read", () => {
    const template = `# class ProcessTupleOperator(UDFOperatorV2):
#     def open(self):
#         self.count = self.UiParameter("count", AttributeType.INT).value`;

    expect(declaredParameters(template, [])).toEqual({ parameters: [] });
    expect(declaredParameters("", [])).toEqual({ parameters: [] });
    expect(
      declaredParameters(
        udf(`self.a = self.UiParameter(name_of_it, AttributeType.INT).value
self.b = self.UiParameter("b", AttributeType.COMPLEX).value
self.c = self.UiParameter("c", AttributeType.INT, value=Resource.DATASET).value
self.d = other.UiParameter("d", AttributeType.INT).value`),
        []
      )
    ).toEqual({ parameters: [] });
  });

  it("says what is wrong when a name is declared twice, or two classes declare parameters", () => {
    expect(
      declaredParameters(
        udf(`self.a = self.UiParameter("a", AttributeType.INT).value
self.b = self.UiParameter("a", AttributeType.STRING).value`),
        []
      )
    ).toEqual({ problem: "The parameter a is declared more than once." });
    expect(declaredParameters(`${udf("pass")}\nclass ProcessTableOperator(UDFTableOperator):\n    pass\n`, [])).toEqual(
      {
        problem: "Only one UDF class may declare parameters.",
      }
    );
  });
});

describe("parameterDeclaration", () => {
  const insert = (code: string, edit: { offset: number; text: string }) =>
    code.slice(0, edit.offset) + edit.text + code.slice(edit.offset);

  it("declares a parameter at the start of open()", () => {
    const code = udf("self.count = 0");

    const edit = parameterDeclaration(code, "rate", "double");

    if ("problem" in edit) throw new Error(edit.problem);
    const changed = insert(code, edit);
    expect(changed).toContain(
      `    def open(self) -> None:\n        self.rate = self.UiParameter(name="rate", type=AttributeType.DOUBLE).value\n        self.count = 0`
    );
    expect(declaredParameters(changed, [])).toEqual({ parameters: [parameter("rate", "double")] });
  });

  it("writes open() for a UDF class that has none, and names the attribute so Python takes it", () => {
    const code = `from pytexera import *

class ProcessTableOperator(UDFTableOperator):
    @overrides
    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        yield table
`;

    const edit = parameterDeclaration(code, "max rows", "integer");

    if ("problem" in edit) throw new Error(edit.problem);
    const changed = insert(code, edit);
    expect(changed).toContain(
      `class ProcessTableOperator(UDFTableOperator):\n    @overrides\n    def open(self) -> None:\n        self.max_rows = self.UiParameter(name="max rows", type=AttributeType.INT).value\n\n    @overrides\n    def process_table`
    );
    expect(declaredParameters(changed, [])).toEqual({ parameters: [parameter("max rows", "integer")] });
  });

  it.each([
    [
      "code without a UDF class",
      "x = 1\n",
      "rate",
      "There is no UDF class, such as ProcessTupleOperator, to declare it in.",
    ],
    [
      "a name that is declared already",
      udf('self.rate = self.UiParameter("rate", AttributeType.INT).value'),
      "rate",
      "The parameter rate is declared already.",
    ],
    ["no name", udf("pass"), " ", "A parameter needs a name."],
  ])("refuses %s", (_, code, name, problem) => {
    expect(parameterDeclaration(code, name, "double")).toEqual({ problem });
  });
});
