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

import { expect, test } from "../support/fixtures.ts";

// A UDF that puts a greeting, which the user gives, before each line.
const greeting = `from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def open(self) -> None:
        pass

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["line"] = self.greeting + " " + tuple_["line"]
        yield tuple_
`;

test("user declares a parameter of a Python UDF, gives it a value, and the engine hands the value to the code", async ({
  editor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("parameters"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada\ngrace");
  await editor.addOperator("Python UDF");
  await editor.link("Text Input", "Python UDF");
  await editor.select("Python UDF");
  await editor.openCode("Python UDF");
  await editor.replaceCode("Python UDF", greeting);
  await editor.closeCode("Python UDF");

  // Declaring the parameter writes it into the code's open().
  const udf = editor.properties("Python UDF");
  await udf.getByRole("button", { name: "Add a parameter" }).click();
  const form = udf.getByRole("form", { name: "New parameter" });
  await form.getByRole("textbox", { name: "Name" }).fill("greeting");
  await form.getByRole("button", { name: "Declare it in the code" }).click();
  await udf.getByRole("textbox", { name: "greeting string" }).fill("hello");
  await udf.getByRole("checkbox", { name: "Keep its result for viewing" }).check();

  await editor.execute();

  await expect(editor.resultCell("hello ada")).toBeVisible();
  await expect(editor.resultCell("hello grace")).toBeVisible();
  await editor.saved();
  const saved = await backend.workflowContent(workflow);
  const operator = saved.operators.find(each => each.operatorType === "PythonUDFV2")!;
  expect(operator.operatorProperties.code).toContain(
    'self.greeting = self.UiParameter(name="greeting", type=AttributeType.STRING).value'
  );
  expect(operator.operatorProperties.uiParameters).toEqual([
    { attribute: { attributeName: "greeting", attributeType: "string" }, value: "hello" },
  ]);
});
