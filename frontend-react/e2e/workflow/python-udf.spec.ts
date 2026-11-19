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

// A UDF that adds a column with each line in capitals.
const shouting = `from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["shout"] = tuple_["line"].upper()
        yield tuple_
`;

test("user writes a Python UDF: the operators after it get its new column, and the result its values", async ({
  editor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("python"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada\ngrace");
  await editor.addOperator("Python UDF");
  await editor.link("Text Input", "Python UDF");

  // The code is written in an editor of its own, and typed into like any text.
  const udf = await editor.select("Python UDF");
  await editor.openCode("Python UDF");
  await editor.replaceCode("Python UDF", shouting);
  await editor.page.keyboard.type("# typed by hand");
  await expect(editor.codeText("Python UDF")).toContainText('tuple_["shout"] = tuple_["line"].upper()');
  await expect(editor.codeText("Python UDF")).toContainText("# typed by hand");
  await editor.closeCode("Python UDF");

  // The UDF says which column it adds.
  const columns = udf.getByRole("list", { name: "Extra output column(s)" });
  await columns.locator("xpath=..").getByRole("button", { name: "Add" }).click();
  await columns.getByLabel("Attribute Name *").fill("shout");
  await editor.choose(columns.getByRole("combobox", { name: "Attribute Type *" }), "string");

  // The operator after the UDF is offered the column the UDF adds, beside the one it was given.
  await editor.addOperator("Filter");
  await editor.link("Python UDF", "Filter");
  const filter = await editor.select("Filter");
  await filter.getByRole("button", { name: "Add" }).click();
  const predicate = filter.getByRole("list", { name: "Predicates *" }).getByRole("listitem");
  const attribute = predicate.getByRole("combobox", { name: "Attribute *" });
  await expect.poll(() => editor.options(attribute)).toEqual(["line", "shout"]);
  await editor.choose(attribute, "shout");
  await editor.choose(predicate.getByRole("combobox", { name: "Condition *" }), "=");
  await predicate.getByLabel("Value").fill("ADA");
  await filter.getByRole("checkbox", { name: "Keep its result for viewing" }).check();

  await editor.execute();

  await expect(editor.operator("Python UDF")).toContainText("Completed · 2 rows");
  await expect(editor.operator("Filter")).toContainText("Completed · 1 rows");
  await expect(editor.resultCell("ADA")).toBeVisible();

  // The code is saved with the workflow: it is there when the workflow is opened again.
  await editor.saved();
  await editor.page.reload();
  await editor.select("Python UDF");
  await editor.openCode("Python UDF");
  await expect(editor.codeText("Python UDF")).toContainText("# typed by hand");
});
