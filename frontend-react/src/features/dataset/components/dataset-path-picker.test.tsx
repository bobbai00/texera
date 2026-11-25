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

import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { renderWithProviders } from "@/testing/render";
import { signInAs } from "@/testing/session";
import { DatasetFilePicker, DatasetVersionPicker } from "./dataset-path-picker";

/** The admin's datasets: penguins with two versions, and iris with none. Flowers is someone else's. */
function addDatasets() {
  addDataset(db, {
    name: "penguins",
    versions: [
      { name: "v1", files: { "adelie.csv": "species\nAdelie\n" } },
      { name: "v2 - by island", files: { "islands/biscoe.csv": "species\nGentoo\n", "README.md": "# Penguins\n" } },
    ],
  });
  addDataset(db, { name: "iris" });
  addDataset(db, { name: "flowers", ownerUid: reader.uid });
  signInAs(admin);
}

/** As addDatasets, and the reader's public dataset census, which anyone may read a file of. */
function addDatasetsWithAPublicOne() {
  addDataset(db, { name: "census", ownerUid: reader.uid, isPublic: true });
  addDatasets();
}

/** Shows a picker that holds its value as a form does, and reports what is picked. */
function renderPicker(Picker: typeof DatasetFilePicker, initial = "") {
  const onChange = vi.fn();
  function Field() {
    const [value, setValue] = useState(initial);
    return (
      <>
        <label htmlFor="path">File</label>
        <Picker
          id="path"
          value={value}
          onChange={path => {
            setValue(path);
            onChange(path);
          }}
        />
      </>
    );
  }
  return { onChange, ...renderWithProviders(<Field />) };
}

describe("DatasetFilePicker", () => {
  it("picks a file of one of the user's datasets, starting at the newest version", async () => {
    addDatasets();
    const { user, onChange } = renderPicker(DatasetFilePicker);
    const field = screen.getByRole("button", { name: "File" });
    expect(field).toHaveTextContent("Choose a file");

    await user.click(field);
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });
    const datasets = await within(dialog).findByRole("list", { name: "Datasets" });
    // Someone else's dataset is not among them.
    const names = within(datasets)
      .getAllByRole("button")
      .map(button => button.textContent)
      .sort();
    expect(names).toEqual(["iristexera", "penguinstexera"]);

    await user.click(within(datasets).getByRole("button", { name: /^penguins/ }));
    expect(await within(dialog).findByRole("combobox", { name: "Version" })).toHaveTextContent("v2 - by island");
    await user.click(await within(dialog).findByRole("button", { name: /^biscoe\.csv/ }));

    expect(onChange).toHaveBeenCalledWith("/dataset/texera/penguins/v2 - by island/islands/biscoe.csv");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The field shows the file by its name, under its dataset and version; the whole path shows on hover.
    expect(field).toHaveTextContent("biscoe.csvpenguins · v2 - by island");
    expect(field).toHaveAttribute("title", "/dataset/texera/penguins/v2 - by island/islands/biscoe.csv");
  });

  it("opens on the dataset and the version of the file that is chosen, and goes back to the datasets", async () => {
    addDatasets();
    const { user } = renderPicker(DatasetFilePicker, "/dataset/texera/penguins/v1/adelie.csv");
    expect(screen.getByRole("button", { name: "File" })).toHaveTextContent("adelie.csvpenguins · v1");

    await user.click(screen.getByRole("button", { name: "File" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });
    expect(await within(dialog).findByRole("heading", { name: "penguins" })).toBeVisible();
    expect(await within(dialog).findByRole("combobox", { name: "Version" })).toHaveTextContent("v1");
    expect(await within(dialog).findByRole("button", { name: /^adelie\.csv/ })).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Back to the datasets" }));
    expect(await within(dialog).findByRole("list", { name: "Datasets" })).toBeVisible();
  });

  it("reads the path as the server does, of a dataset named dataset with a folder named dataset too", async () => {
    addDataset(db, {
      name: "dataset",
      versions: [{ name: "v1", files: { "dataset/adelie.csv": "species\nAdelie\n" } }],
    });
    signInAs(admin);
    const { user } = renderPicker(DatasetFilePicker, "/dataset/texera/dataset/v1/dataset/adelie.csv");
    const field = screen.getByRole("button", { name: "File" });
    expect(field).toHaveTextContent("adelie.csvdataset · v1");

    await user.click(field);
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });
    expect(await within(dialog).findByRole("heading", { name: "dataset" })).toBeVisible();
    expect(await within(dialog).findByRole("combobox", { name: "Version" })).toHaveTextContent("v1");
  });

  it("reads a path without the prefix, as the paths of datasets were written before", () => {
    addDatasets();
    renderPicker(DatasetFilePicker, "/texera/penguins/v1/adelie.csv");

    expect(screen.getByRole("button", { name: "File" })).toHaveTextContent("adelie.csvpenguins · v1");
  });

  it("shows a file of a model that is chosen, which an operator reads as any other file", async () => {
    addDatasets();
    const { user } = renderPicker(DatasetFilePicker, "/model/texera/resnet/v3/labels.csv");
    const field = screen.getByRole("button", { name: "File" });
    expect(field).toHaveTextContent("labels.csvresnet · v3");
    expect(field).toHaveAttribute("title", "/model/texera/resnet/v3/labels.csv");

    // There is no dataset of it to open on: the datasets are offered to pick from.
    await user.click(field);
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });
    expect(await within(dialog).findByRole("list", { name: "Datasets" })).toBeVisible();
  });

  it("shows no file for the path of a version as a whole, which names none", () => {
    addDatasets();
    renderPicker(DatasetFilePicker, "/dataset/texera/penguins/v1");

    expect(screen.getByRole("button", { name: "File" })).toHaveTextContent("Choose a file");
  });

  it("says so when a dataset has no version to pick a file from, and when no dataset is found", async () => {
    addDatasets();
    const { user } = renderPicker(DatasetFilePicker);
    await user.click(screen.getByRole("button", { name: "File" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });

    await user.click(await within(dialog).findByRole("button", { name: /^iris/ }));
    expect(await within(dialog).findByText("No versions yet")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Back to the datasets" }));
    await user.type(within(dialog).getByRole("searchbox", { name: "Search datasets" }), "zebra");
    expect(await within(dialog).findByText("No datasets found")).toBeVisible();
  });
});

describe("the datasets to pick from", () => {
  it("are every dataset the user may read, someone else's public one too, found by the words typed", async () => {
    addDatasetsWithAPublicOne();
    const { user } = renderPicker(DatasetFilePicker);
    await user.click(screen.getByRole("button", { name: "File" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a file" });

    const datasets = await within(dialog).findByRole("list", { name: "Datasets" });
    expect(within(datasets).getByRole("button", { name: /^census/ })).toHaveTextContent("reader@example.com");
    await user.type(within(dialog).getByRole("searchbox", { name: "Search datasets" }), "peng");

    expect(
      within(datasets)
        .getAllByRole("button")
        .map(button => button.textContent)
    ).toEqual(["penguinstexera"]);
  });
});

describe("DatasetVersionPicker", () => {
  it("picks a version of a dataset as a whole", async () => {
    addDatasets();
    const { user, onChange } = renderPicker(DatasetVersionPicker);

    await user.click(screen.getByRole("button", { name: "File" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a dataset version" });
    await user.click(await within(dialog).findByRole("button", { name: /^penguins/ }));
    await user.click(await within(dialog).findByRole("combobox", { name: "Version" }));
    await user.click(await screen.findByRole("option", { name: /^v1/ }));
    await user.click(within(dialog).getByRole("button", { name: "Choose this version" }));

    expect(onChange).toHaveBeenCalledWith("/dataset/texera/penguins/v1");
    expect(screen.getByRole("button", { name: "File" })).toHaveTextContent("penguinsv1");
  });

  it("takes the path of a model's version for no dataset, and shows the path on hover", () => {
    addDatasets();
    renderPicker(DatasetVersionPicker, "/model/texera/resnet/v1");

    const field = screen.getByRole("button", { name: "File" });
    expect(field).toHaveTextContent("Choose a dataset version");
    expect(field).toHaveAttribute("title", "/model/texera/resnet/v1");
  });
});
