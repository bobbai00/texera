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

test("user makes a computing unit, sees it running, and ends it", async ({ editor, backend }) => {
  const { page } = editor;
  const name = backend.workflowName("unit");
  await page.goto("computing-units");
  const list = page.getByRole("list", { name: "Computing units" });

  await page.getByRole("button", { name: "New computing unit" }).click();
  const dialog = page.getByRole("dialog", { name: "New computing unit" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Make it" }).click();

  const unit = list.getByRole("listitem").filter({ hasText: name });
  await expect(unit).toContainText("Running");
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(unit).toBeHidden();
});
