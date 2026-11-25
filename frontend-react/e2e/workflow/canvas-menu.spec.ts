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

test("user duplicates an operator, copies and pastes one with the keyboard, and leaves a comment", async ({
  editor,
  backend,
  page,
}) => {
  const workflow = await backend.createWorkflow(backend.workflowName("menu"));
  await editor.open(workflow);
  await editor.addOperator("Text Input");
  await (await editor.select("Text Input")).getByLabel("Text *").fill("ada\ngrace");

  // The menu on an operator acts on it.
  await (await editor.openMenu("Text Input")).getByRole("menuitem", { name: /Duplicate/ }).click();
  await expect(editor.operator("Text Input")).toHaveCount(2);

  // The keyboard copies what is selected to the system's clipboard, and pastes it where the pointer is.
  await editor.operator("Text Input").first().click();
  await page.keyboard.press("ControlOrMeta+c");
  // Beside the empty spot where the comment starts next, so that the comment is not started on the copy.
  const spot = await editor.emptySpot();
  await editor.canvas.hover({ position: { x: spot.x + 160, y: spot.y } });
  await page.keyboard.press("ControlOrMeta+v");
  await expect(editor.operator("Text Input")).toHaveCount(3);

  // A comment starts where the empty canvas is right-clicked.
  await (await editor.openMenu()).getByRole("menuitem", { name: "Comment here" }).click();
  const thread = page.getByRole("region", { name: "Comments" });
  await thread.getByRole("textbox", { name: "Write a comment" }).fill("Paste the penguins here");
  await thread.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(editor.comment("texera")).toContainText("Paste the penguins here");

  await editor.saved();
  const saved = await backend.workflowContent(workflow);
  expect(saved.operators).toHaveLength(3);
  expect(new Set(saved.operators.map(operator => operator.operatorID)).size).toBe(3);
  expect(saved.operators.map(operator => operator.operatorProperties.textInput)).toEqual([
    "ada\ngrace",
    "ada\ngrace",
    "ada\ngrace",
  ]);
  expect(saved.commentBoxes[0].comments.map(comment => comment.content)).toEqual(["Paste the penguins here"]);
});
