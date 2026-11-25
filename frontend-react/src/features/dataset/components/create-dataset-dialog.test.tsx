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
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";

const nameRule = "Use only letters, numbers, hyphens, and underscores, up to 128 characters.";

/**
 * Opens the datasets page as the admin, opens the dialog from its button, fills it in and presses Create.
 * user-event cannot type an empty text, so empty fields are left as they are.
 */
async function createDataset({ name = "", description = "", isPublic = false }) {
  const rendered = renderApp("/datasets", { session: sessionFor(admin) });
  const { user } = rendered;
  await user.click(await screen.findByRole("button", { name: "Create dataset" }));
  const dialog = screen.getByRole("dialog", { name: "Create dataset" });
  if (name) await user.type(within(dialog).getByLabelText("Name"), name);
  if (description) await user.type(within(dialog).getByLabelText("Description"), description);
  if (isPublic) await user.click(within(dialog).getByRole("checkbox", { name: "Public" }));
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  return { ...rendered, dialog };
}

describe("CreateDatasetDialog", () => {
  it("creates a private dataset and opens its page", async () => {
    const { router } = await createDataset({ name: "iris", description: "Measurements of 150 iris flowers" });

    expect(await screen.findByRole("heading", { name: "iris" })).toBeInTheDocument();
    expect(screen.getByText("Measurements of 150 iris flowers")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/datasets/${db.datasets[0].did}`);
    expect(db.resources[0]).toMatchObject({ ownerUid: admin.uid, isPublic: false });
  });

  it("creates a public dataset when Public is checked", async () => {
    await createDataset({ name: "iris", isPublic: true });

    expect(await screen.findByRole("heading", { name: "iris" })).toBeInTheDocument();
    expect(db.resources[0]).toMatchObject({ isPublic: true });
  });

  it("lists the new dataset on the datasets page", async () => {
    const { user } = await createDataset({ name: "iris" });
    await screen.findByRole("heading", { name: "iris" });

    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Datasets" }));

    expect(await screen.findByRole("link", { name: "iris" })).toBeInTheDocument();
  });

  it("accepts a name of 128 letters, numbers, hyphens, and underscores", async () => {
    const name = "Iris_2026-v1".padEnd(128, "x");

    await createDataset({ name });

    expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
  });

  it("asks for a name when there is none", async () => {
    const { dialog } = await createDataset({ description: "Iris flowers" });

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a name.");
    expect(within(dialog).getByLabelText("Name")).toBeInvalid();
    expect(db.datasets).toEqual([]);
  });

  it.each([
    ["has a space", "iris flowers"],
    ["has a dot", "iris.csv"],
    ["has a letter outside A to Z", "Blüten"],
    ["is longer than 128 characters", "x".repeat(129)],
  ])("explains the rule for names, without renaming, when the name %s", async (_, name) => {
    const { dialog } = await createDataset({ name });

    expect(within(dialog).getByRole("alert")).toHaveTextContent(nameRule);
    expect(within(dialog).getByLabelText("Name")).toHaveValue(name);
    expect(db.datasets).toEqual([]);
  });

  it("shows the server's message when the user has a dataset of that name", async () => {
    addDataset(db, { name: "iris" });

    const { dialog } = await createDataset({ name: "iris" });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Dataset with the same name already exists");
    expect(db.datasets).toHaveLength(1);
  });

  it("shows the server's message when the server fails", async () => {
    server.use(
      http.post("/api/dataset/create", () =>
        HttpResponse.json(
          { code: 500, message: "There was an error processing your request. It has been logged (ID 1f2e)." },
          { status: 500 }
        )
      )
    );

    const { dialog } = await createDataset({ name: "iris" });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("There was an error processing your request.");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("creates nothing when it is cancelled", async () => {
    const { user } = renderApp("/datasets", { session: sessionFor(admin) });
    await user.click(await screen.findByRole("button", { name: "Create dataset" }));
    await user.type(screen.getByLabelText("Name"), "iris");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("No datasets yet")).toBeInTheDocument();
    expect(db.datasets).toEqual([]);
  });
});
