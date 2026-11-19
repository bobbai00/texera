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

test("user looks back at an earlier version, sees what each save changed, and restores one", async ({
  editor,
  backend,
  page,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("history"));
  await editor.open(workflow);
  // Each save is a version: what changed within a moment of the last change is saved with it.
  await editor.addOperator("Text Input");
  await editor.saved();
  await editor.addOperator("Limit");
  await editor.link("Text Input", "Limit");
  await editor.saved();

  const versions = await editor.openHistory();
  await expect(versions.getByRole("button")).toHaveText([
    /saved now.*Added Limit · Added a link/,
    /Added Text Input/,
    /Created the workflow/,
  ]);

  // A version is shown in place of the workflow, with what its save changed marked.
  await versions.getByRole("button", { name: /Added Limit/ }).click();
  await expect(editor.versionBar).toBeVisible();
  await expect(page).toHaveURL(/\?version=\d+$/);
  await expect(editor.operator("Limit")).toContainText("Added");
  await editor.versionBar.getByRole("button", { name: "The version before" }).click();
  await expect(editor.operator("Text Input")).toContainText("Added");
  await expect(editor.operator("Limit")).toBeHidden();

  // Restoring it is a change like any other: it is saved, and can be undone.
  await editor.versionBar.getByRole("button", { name: "Restore" }).click();
  await expect(editor.versionBar).toBeHidden();
  await expect(editor.operator("Limit")).toBeHidden();
  await editor.saved();
  expect((await backend.workflowContent(workflow)).operators.map(operator => operator.operatorType)).toEqual([
    "TextInput",
  ]);
  await page.getByRole("status").filter({ hasText: "is restored" }).getByRole("button", { name: "Undo" }).click();
  await expect(editor.operator("Limit")).toBeVisible();
  await editor.saved();
  expect((await backend.workflowContent(workflow)).links).toHaveLength(1);
});
