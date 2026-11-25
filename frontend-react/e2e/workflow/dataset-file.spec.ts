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

import { textFile } from "../support/backend.ts";
import { expect, test } from "../support/fixtures.ts";

test("user picks a file of a dataset for an operator to read, and executes it", async ({ editor, backend }) => {
  const dataset = await backend.createDataset(backend.datasetName("scan"));
  await backend.uploadFile(dataset, textFile("flowers.csv", "species,sepal_length\nsetosa,5.1\nvirginica,6.3\n"));
  await backend.createVersion(dataset, "flowers");
  const workflow = await backend.createWorkflow(backend.workflowName("scan"));
  await editor.open(workflow);
  await editor.addOperator("CSV File Scan");
  const scan = await editor.select("CSV File Scan");

  // The file is not typed: it is picked from the user's datasets, the newest version first.
  await scan.getByRole("button", { name: "File *" }).click();
  const dialog = editor.page.getByRole("dialog", { name: "Choose a file" });
  await dialog.getByRole("searchbox", { name: "Search datasets" }).fill(dataset.name);
  await dialog.getByRole("button", { name: dataset.name }).click();
  await dialog.getByRole("button", { name: "flowers.csv" }).click();
  await expect(dialog).toBeHidden();
  // The field shows the file by its name, under its dataset and version.
  const path = `/dataset/${dataset.ownerEmail}/${dataset.name}/v1 - flowers/flowers.csv`;
  const file = scan.getByRole("button", { name: "File *" });
  await expect(file).toHaveText(`flowers.csv${dataset.name} · v1 - flowers`);
  await expect(file).toHaveAttribute("title", path);
  // Above the card, a chip names the version the operator reads, and opens to the dataset, at that version.
  const chip = editor.resourceChip(dataset.name, "v1 - flowers");
  await expect(chip).toHaveAttribute("title", path);
  await chip.click();
  const about = editor.page.getByRole("dialog", { name: dataset.name });
  await expect(about.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    new RegExp(`/datasets/${dataset.did}\\?version=\\d+&file=flowers\\.csv$`)
  );
  await editor.page.keyboard.press("Escape");
  await expect(about).toBeHidden();

  // The operator after it is offered the columns of the file.
  await editor.addOperator("Limit");
  await editor.link("CSV File Scan", "Limit");
  await (await editor.select("Limit")).getByLabel("Limit *").fill("1");
  await editor.addOperator("Projection");
  await editor.link("Limit", "Projection");
  const projection = await editor.select("Projection");
  await projection.getByRole("button", { name: "Add" }).click();
  const attribute = projection.getByRole("list", { name: "Attributes" }).getByRole("combobox", { name: "Attribute *" });
  await expect.poll(() => editor.options(attribute)).toEqual(["species", "sepal_length"]);
  await editor.choose(attribute, "species");
  await editor.keepResult("Projection");

  await editor.execute();

  await expect(editor.operator("CSV File Scan")).toContainText(/Completed2 rows/);
  await editor.select("Projection");
  await expect(editor.resultCell("setosa")).toBeVisible();
  await expect(editor.resultCell("virginica")).toBeHidden();

  // Opening the picker again shows the dataset and the version that are chosen.
  await (await editor.select("CSV File Scan")).getByRole("button", { name: "File *" }).click();
  await expect(dialog.getByRole("heading", { name: dataset.name })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "flowers.csv" })).toBeVisible();
});
