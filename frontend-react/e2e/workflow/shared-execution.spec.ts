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

// The second browser is the same person's, so the scenario needs no computing unit shared with someone else.
test("an execution is shared: whoever has the workflow open watches it, and whoever opens it later sees how it ended", async ({
  editor,
  secondEditor,
  backend,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("watch"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada\ngrace\nlinus");
  await editor.addOperator("Limit");
  await editor.link("Text Input", "Limit");
  const limit = await editor.select("Limit");
  await limit.getByLabel("Limit *").fill("2");
  await limit.getByRole("checkbox", { name: "Keep its result for viewing" }).check();
  await secondEditor.open(workflow);
  await expect(secondEditor.operator("Limit")).toBeVisible();

  await editor.execute();

  // The second browser did not start the execution, and shows it all the same: each operator, and the result.
  await expect(secondEditor.executionState).toHaveText("Completed");
  await expect(secondEditor.operator("Text Input")).toContainText("Completed · 3 rows");
  await expect(secondEditor.operator("Limit")).toContainText("Completed · 2 rows");
  await secondEditor.select("Limit");
  await expect(secondEditor.resultCell("ada")).toBeVisible();
  await expect(secondEditor.resultCell("grace")).toBeVisible();
  await expect(secondEditor.resultCell("linus")).toBeHidden();

  // Opening the workflow after the execution has ended shows how it ended.
  await secondEditor.page.reload();
  await expect(secondEditor.executionState).toHaveText("Completed");
  await expect(secondEditor.operator("Limit")).toContainText("Completed · 2 rows");

  // An execution started in the second browser is the first one's too.
  await secondEditor.execute();
  await expect(editor.executionState).toHaveText("Completed");
  await expect(editor.operator("Limit")).toContainText("Completed · 2 rows");
});
