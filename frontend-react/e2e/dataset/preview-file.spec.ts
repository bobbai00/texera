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

// The browser reads the file from the storage server, another origin, with the link the File Service signs.
test("user looks inside a CSV file of a dataset, and sees its rows as a table", async ({ app, backend }) => {
  const dataset = await backend.createDataset(backend.datasetName("preview"));
  await backend.uploadFile(dataset, textFile("iris.csv", "sepal_length,species\n5.1,setosa\n4.9,versicolor\n"));
  await backend.uploadFile(dataset, textFile("notes.txt", "Fisher, 1936\n"));
  await backend.createVersion(dataset, "iris");

  await app.openDataset(dataset);
  const preview = await app.previewFile("iris.csv");

  await expect(preview.getByRole("columnheader", { name: "species", exact: true })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "versicolor", exact: true })).toBeVisible();
});
