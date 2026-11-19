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

test("user finds an execution in the workflow's history, names and bookmarks it, and opens what it executed", async ({
  editor,
  backend,
  page,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("executions"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada\ngrace");
  await editor.saved();
  await editor.execute();

  await editor.openHistory();
  await page.getByRole("tab", { name: "Executions" }).click();
  const execution = page.getByRole("list", { name: "Executions" }).getByRole("listitem").first();
  await expect(execution).toContainText(/Completed · by texera/);

  await execution.getByRole("button", { name: "Rename" }).click();
  await execution.getByRole("textbox", { name: "Name of the execution" }).fill("Two names");
  await page.keyboard.press("Enter");
  await expect(execution).toHaveAccessibleName("Two names");
  await execution.getByRole("button", { name: "Bookmark" }).click();
  await expect(execution.getByRole("button", { name: "Bookmark" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Bookmarked", exact: true }).click();
  await expect(page.getByRole("list", { name: "Executions" }).getByRole("listitem")).toHaveCount(1);

  // What each operator did is kept with the execution.
  await execution.getByRole("button", { name: "Statistics" }).click();
  await expect(execution.getByRole("table", { name: "Statistics" }).getByRole("row").nth(1)).toContainText(
    "Text Input"
  );

  await execution.getByRole("button", { name: "Open its version" }).click();
  await expect(editor.versionBar).toBeVisible();
  await expect(editor.operator("Text Input")).toBeVisible();
});
