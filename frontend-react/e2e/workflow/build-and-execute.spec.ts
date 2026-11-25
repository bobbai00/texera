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

test("user builds a workflow, is offered each operator's input columns, and executes it", async ({
  editor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("build"));
  await editor.open(workflow);
  const execute = editor.toolbar.getByRole("button", { name: "Execute" });

  // An operator that lacks something it needs cannot be executed.
  await editor.addOperator("Text Input");
  await expect(execute).toBeDisabled();
  const text = await editor.select("Text Input");
  await text.getByLabel("Text *").fill("ada\ngrace\nlinus");
  await expect(execute).toBeEnabled();

  // The compiling service says which columns reach the filter: the one the text input puts out.
  await editor.addOperator("Filter");
  await editor.link("Text Input", "Filter");
  const filter = await editor.select("Filter");
  await filter.getByRole("button", { name: "Add" }).click();
  const predicate = filter.getByRole("list", { name: "Predicates *" }).getByRole("listitem");
  const attribute = predicate.getByRole("combobox", { name: "Attribute *" });
  await expect.poll(() => editor.options(attribute)).toEqual(["line"]);
  await editor.choose(attribute, "line");
  await editor.choose(predicate.getByRole("combobox", { name: "Condition *" }), "!=");
  await predicate.getByLabel("Value").fill("linus");
  await editor.keepResult("Filter");

  // Renaming the column upstream reaches the filter: it is offered the new name, and told its own is gone.
  await (await editor.select("Text Input")).getByLabel("Attribute Name *").fill("name");
  await editor.select("Filter");
  await expect.poll(() => editor.options(attribute)).toEqual(["line", "name"]);
  await expect(filter.getByRole("alert")).toBeVisible();
  await expect(execute).toBeDisabled();
  await editor.choose(attribute, "name");
  await expect(filter.getByRole("alert")).toBeHidden();

  await editor.execute();

  // Each card says how its operator did: its state, then the rows it took and put out, or those a source put out,
  // side by side in its text.
  await expect(editor.operator("Text Input")).toContainText(/Completed3 rows/);
  await expect(editor.operator("Filter")).toContainText(/Completed3 → 2 rows/);
  await expect(editor.resultChip("Filter", "2 rows")).toBeVisible();
  await expect(editor.resultCell("ada")).toBeVisible();
  await expect(editor.resultCell("grace")).toBeVisible();
  await expect(editor.resultCell("linus")).toBeHidden();

  // What was built is saved, by the shared editing service.
  await editor.saved();
  const saved = await backend.workflowContent(workflow);
  expect(saved.operators.map(operator => operator.operatorType)).toEqual(["Filter", "TextInput"]);
  expect(saved.links).toHaveLength(1);
});
