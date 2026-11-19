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

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

// What the list does for every kind of resource is tested in components/resource/resource-list-page.test.tsx.
describe("the datasets page", () => {
  it("lists the user's datasets, with the button that creates one", async () => {
    addDataset(db, { name: "iris", description: "Iris flowers" });

    renderApp("/datasets", { session: sessionFor(admin) });

    const list = await screen.findByRole("list", { name: "Datasets" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("iris");
    expect(screen.getByRole("button", { name: "Create dataset" })).toBeInTheDocument();
  });

  it("opens a dataset's page from its name", async () => {
    const { did } = addDataset(db, { name: "iris" });
    const { user, router } = renderApp("/datasets", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("link", { name: "iris" }));

    expect(await screen.findByRole("heading", { level: 1, name: "iris" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/datasets/${did}`);
  });

  it("deletes a dataset from its row, with its versions and files", async () => {
    addDataset(db, { name: "iris", versions: [{ name: "v1", files: { "iris.csv": "5.1" } }] });
    const { user } = renderApp("/datasets", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for iris" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete iris?" });
    expect(dialog).toHaveTextContent("Its versions and files are deleted too.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No datasets yet")).toBeInTheDocument();
    await waitFor(() => expect(db.datasets).toEqual([]));
  });
});
