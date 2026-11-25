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

test("user creates a dataset", async ({ app, backend }) => {
  const name = backend.datasetName("create");
  const description = "Measurements of 150 iris flowers";

  await app.createDataset({ name, description });

  await expect(app.datasetHeading(name)).toBeVisible();
  await expect(app.datasetDescription(description)).toBeVisible();
});

test("user uploads files and creates a version, then sees the files", async ({ app, backend }) => {
  // The dataset has a version already, so the page must turn to the new one to show the new files.
  const dataset = await backend.createDataset(backend.datasetName("upload"));
  await backend.uploadFile(dataset, textFile("iris.csv", "sepal_length,species\n5.1,setosa\n"));
  await backend.createVersion(dataset, "iris");

  await app.openDataset(dataset);
  await app.uploadFiles([
    textFile("penguins.csv", "species,island\nAdelie,Torgersen\n"),
    textFile("README.md", "# Flowers and penguins\n"),
  ]);
  await app.createVersion("penguins");

  for (const name of ["iris.csv", "penguins.csv", "README.md"]) {
    await expect(app.file(name)).toBeVisible();
  }
});
