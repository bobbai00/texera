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

test("user makes a workflow public, finds it in the hub, looks inside it, and copies it", async ({
  editor,
  backend,
}) => {
  const { page } = editor;
  const workflow = await backend.createWorkflow(backend.workflowName("hub"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada");
  await editor.saved();

  await page.goto("workflows");
  await page.getByRole("button", { name: `More actions for ${workflow.name}` }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await page
    .getByRole("dialog")
    .getByRole("checkbox", { name: /Public/ })
    .click();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Public/ })).toBeChecked();
  await page.keyboard.press("Escape");

  await page.goto("hub");
  await page.getByRole("list", { name: "Public workflows" }).getByRole("link", { name: workflow.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: workflow.name })).toBeVisible();
  await editor.operator("Text Input").click();
  await expect(editor.properties("Text Input").getByLabel("Text *")).toHaveValue("ada");

  await page.getByRole("button", { name: "Make a copy" }).click();
  await expect(page).toHaveURL(/\/workflows\/\d+$/);
  await expect(editor.operator("Text Input")).toBeVisible();
});
