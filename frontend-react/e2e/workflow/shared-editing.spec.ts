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

import { admin, reader } from "../support/backend.ts";
import { expect, test } from "../support/fixtures.ts";

test("two people edit one workflow: each sees what the other does, and one follows the other into their code", async ({
  editor,
  readerEditor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("together"));
  await backend.shareWorkflow(workflow, reader.email, "WRITE");
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await editor.addOperator("Python UDF");
  await editor.link("Text Input", "Python UDF");

  // Whoever comes next gets what the room holds, and each is shown that the other is there.
  await readerEditor.open(workflow);
  await expect(readerEditor.operator("Python UDF")).toBeVisible();
  await expect(editor.follow(reader.username)).toBeVisible();
  await expect(readerEditor.follow(admin.username)).toBeVisible();

  // What one adds, the other sees, with the pointer of the one who is doing it.
  await readerEditor.addOperator("Limit");
  await expect(editor.operator("Limit")).toBeVisible();
  await readerEditor.operator("Limit").hover();
  await expect(editor.canvas.getByRole("img", { name: `Pointer of ${reader.username}` })).toBeVisible();

  // The admin follows the reader: what the reader selects is selected, and their code opens and closes with them.
  await editor.follow(reader.username).click();
  await readerEditor.select("Python UDF");
  await expect(editor.properties("Python UDF")).toBeVisible();
  await expect(editor.operator("Python UDF").getByRole("list", { name: "Selected by" })).toContainText(reader.username);
  await readerEditor.openCode("Python UDF");
  await expect(editor.code("Python UDF")).toBeVisible();
  await expect(editor.code("Python UDF").getByRole("list", { name: "Also in this code" })).toContainText(
    reader.username
  );

  // Both type into the same code. Each sees the other's typing as it is typed, and their cursor with their name.
  await readerEditor.typeCode("Python UDF", "# from the reader\n");
  await expect(editor.codeText("Python UDF")).toContainText("# from the reader");
  await expect(editor.codeText("Python UDF").getByText(reader.username, { exact: true })).toBeAttached();
  await editor.typeCode("Python UDF", "# from the admin\n");
  await expect(readerEditor.codeText("Python UDF")).toContainText("# from the admin");
  await expect(readerEditor.codeText("Python UDF")).toContainText("# from the reader");

  await readerEditor.closeCode("Python UDF");
  await expect(editor.properties("Python UDF")).toBeVisible();
  await readerEditor.select("Text Input");
  await expect(editor.properties("Text Input")).toBeVisible();

  // Selecting something oneself is going one's own way again.
  await editor.select("Limit");
  await expect(editor.follow(reader.username)).toHaveAttribute("aria-pressed", "false");
  await readerEditor.select("Python UDF");
  await expect(editor.properties("Limit")).toBeVisible();

  // The service saves what the two of them made: nobody's browser does.
  await editor.saved();
  const saved = await backend.workflowContent(workflow);
  expect(saved.operators.map(operator => operator.operatorType)).toEqual(["Limit", "PythonUDFV2", "TextInput"]);
  const code = saved.operators.find(operator => operator.operatorType === "PythonUDFV2")!.operatorProperties.code;
  expect(code).toContain("# from the reader");
  expect(code).toContain("# from the admin");
});

test("someone who may only view a workflow sees it change, and has nothing to change it with", async ({
  editor,
  readerEditor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("view-only"));
  await backend.shareWorkflow(workflow, reader.email, "READ");
  await editor.open(workflow);
  await editor.addOperator("Python UDF");

  await readerEditor.open(workflow);
  await expect(readerEditor.toolbar.getByRole("status")).toHaveText("View only");
  await expect(readerEditor.page.getByRole("searchbox", { name: "Search operators" })).toBeHidden();
  await expect(readerEditor.operator("Python UDF")).toBeVisible();

  // The code can be read, with what the owner types into it, but not written.
  await readerEditor.select("Python UDF");
  await readerEditor.properties("Python UDF").getByRole("button", { name: "View the Python code" }).click();
  await editor.select("Python UDF");
  await editor.openCode("Python UDF");
  await editor.typeCode("Python UDF", "# only the owner writes\n");
  await expect(readerEditor.codeText("Python UDF")).toContainText("# only the owner writes");
  await readerEditor.codeText("Python UDF").click();
  await readerEditor.page.keyboard.type("# not allowed");
  await expect(readerEditor.codeText("Python UDF")).not.toContainText("# not allowed");

  await editor.addOperator("Limit");
  await expect(readerEditor.operator("Limit")).toBeVisible();
});
