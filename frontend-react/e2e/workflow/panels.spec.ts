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

test("user moves and widens the workspace panel, minimizes the properties, and finds both as they left them", async ({
  editor,
  backend,
  page,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("panels"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await editor.select("Text Input");
  const docked = await editor.panelBox("Operators");

  await editor.movePanel("Operators", 120, 80);
  await editor.widenPanel("Operators", 60);
  const moved = { x: docked.x + 120, y: docked.y + 80, width: docked.width + 60 };
  await expect.poll(() => editor.panelBox("Operators")).toEqual(moved);

  await editor.panel("Properties").getByRole("button", { name: "Minimize Properties" }).click();
  await expect(editor.properties("Text Input")).toBeHidden();

  // The browser keeps the panels as the user left them.
  await page.reload();
  await expect(editor.canvas).toBeVisible();
  await expect.poll(() => editor.panelBox("Operators")).toEqual(moved);
  await editor.operator("Text Input").click();
  await expect(editor.properties("Text Input")).toBeHidden();
  await page.getByRole("button", { name: "Properties", exact: true }).click();
  await expect(editor.properties("Text Input")).toBeVisible();

  // Docked again, the panel goes back to its place, as wide as the user made it.
  await editor.panel("Operators").getByRole("button", { name: "Dock Operators" }).click();
  await expect.poll(() => editor.panelBox("Operators")).toEqual({ ...docked, width: docked.width + 60 });
});

test("user drags the icons of the workspace rail into another order, and finds them so after reloading", async ({
  editor,
  backend,
  page,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("rail"));
  await editor.open(workflow);
  expect(await editor.railOrder()).toEqual(["Operators", "Versions", "Executions", "Settings"]);

  await editor.dragRailIcon("Settings", "Operators");
  await expect.poll(() => editor.railOrder()).toEqual(["Settings", "Operators", "Versions", "Executions"]);

  await page.reload();
  await expect(editor.canvas).toBeVisible();
  expect(await editor.railOrder()).toEqual(["Settings", "Operators", "Versions", "Executions"]);

  // The rail of a minimized panel is dragged the same way, and the drag does not show the panel.
  await page.getByRole("button", { name: /^Minimize (Operators|Versions|Executions|Settings)$/ }).click();
  await editor.dragRailIcon("Versions", "Settings");
  await expect.poll(() => editor.railOrder()).toEqual(["Versions", "Settings", "Operators", "Executions"]);
  await expect(page.getByRole("tabpanel")).toBeHidden();
});
