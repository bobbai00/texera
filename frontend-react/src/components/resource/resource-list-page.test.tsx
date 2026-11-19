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
import { http, HttpResponse } from "msw/http";
import { describe, expect, it, vi } from "vitest";
import type { ResourceDeletion } from "@/lib/resource";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { addModel } from "@/testing/mock-api/model";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";
import { spokenText } from "@/testing/text";
import { ResourceListPage } from "./resource-list-page";

const day = 24 * 60 * 60 * 1000;
const nov12 = Date.UTC(2026, 10, 12, 12);

/** Deletes a dataset of the fake backend, as a kind's own call would. */
const deletion: ResourceDeletion = {
  run: vi.fn((id: number) => {
    db.datasets = db.datasets.filter(dataset => dataset.did !== id);
    db.resources = db.resources.filter(resource => resource.type !== "dataset" || resource.id !== id);
    return Promise.resolve();
  }),
  consequence: "Its versions and files are deleted too.",
};

/** Shows the datasets page as the admin. */
function renderDatasets() {
  return renderWithProviders(
    <ResourceListPage
      kind="dataset"
      deletion={deletion}
      emptyDescription="Create a dataset to upload files."
    />,
    { session: sessionFor(admin) }
  );
}

/** The rows of the list, each as what it says. */
async function rows(label = "Datasets") {
  const list = await screen.findByRole("list", { name: label });
  return within(list).getAllByRole("listitem").map(spokenText);
}

async function openMenu(user: ReturnType<typeof renderDatasets>["user"], name: string) {
  await user.click(await screen.findByRole("button", { name: `More actions for ${name}` }));
  return screen.findByRole("menu");
}

describe("ResourceListPage", () => {
  it("lists what the user owns and what is shared with them, newest first, but not what is only public", async () => {
    addDataset(db, { name: "iris", description: "Iris flowers", creationTime: nov12 });
    addDataset(db, {
      name: "penguins",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "READ" }],
      creationTime: nov12 + 2 * day,
    });
    addDataset(db, { name: "census", ownerUid: reader.uid, isPublic: true, creationTime: nov12 + day });
    addDataset(db, { name: "weather", description: "Daily highs", isPublic: true, creationTime: nov12 - day });

    renderDatasets();

    expect(screen.getByRole("heading", { level: 1, name: "Datasets" })).toBeInTheDocument();
    expect(await rows()).toEqual([
      "penguins Private reader@example.com · Nov 14, 2026",
      "iris Private Iris flowers texera · Nov 12, 2026",
      "weather Public Daily highs texera · Nov 11, 2026",
    ]);
  });

  it.each([
    ["dataset", "Datasets", () => addDataset(db, { name: "iris" }), "/datasets/1"],
    ["workflow", "Workflows", () => addWorkflow(db, { name: "iris" }), "/workflows/1"],
    ["model", "Models", () => addModel(db, { name: "iris" }), "/user/model/1"],
  ] as const)("lists the %ss, each name opening the resource's page", async (kind, label, add, href) => {
    add();

    renderWithProviders(
      <ResourceListPage
        kind={kind}
        emptyDescription="None yet."
      />,
      { session: sessionFor(admin) }
    );

    const list = await screen.findByRole("list", { name: label });
    expect(within(list).getByRole("link", { name: "iris" })).toHaveAttribute("href", href);
  });

  it("names a workflow's owner as the server does, and does not say whether it is public", async () => {
    addWorkflow(db, {
      name: "Iris classification",
      description: "A decision tree",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "WRITE" }],
    });

    renderWithProviders(
      <ResourceListPage
        kind="workflow"
        emptyDescription="None yet."
      />,
      { session: sessionFor(admin) }
    );

    expect(await rows("Workflows")).toEqual(["Iris classification A decision tree reader · Nov 12, 2026"]);
  });

  it("finds the resources whose name or description has every word typed in the search box", async () => {
    addDataset(db, { name: "iris", description: "Flowers of three species" });
    addDataset(db, { name: "penguins", description: "Three species of penguins" });
    addDataset(db, { name: "weather" });
    const { user } = renderDatasets();
    await rows();

    await user.type(screen.getByRole("searchbox", { name: "Search datasets" }), "species flowers");

    await waitFor(async () =>
      expect(await rows()).toEqual(["iris Private Flowers of three species texera · Nov 12, 2026"])
    );
  });

  it("says so when no resource matches the search, and keeps the search box", async () => {
    addDataset(db, { name: "iris" });
    const { user } = renderDatasets();
    await rows();

    await user.type(screen.getByRole("searchbox", { name: "Search datasets" }), "zebra");

    expect(await screen.findByText("No datasets match “zebra”")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Datasets" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search datasets" })).toHaveValue("zebra");
  });

  it("lists in the order that is chosen", async () => {
    addDataset(db, { name: "penguins", creationTime: nov12 });
    addDataset(db, { name: "iris", creationTime: nov12 + day });
    addDataset(db, { name: "weather", creationTime: nov12 + 2 * day });
    const { user } = renderDatasets();
    expect((await rows()).map(row => row.split(" ")[0])).toEqual(["weather", "iris", "penguins"]);

    await user.click(screen.getByRole("combobox", { name: "Order" }));
    await user.click(await screen.findByRole("option", { name: "Name, A to Z" }));

    await waitFor(async () =>
      expect((await rows()).map(row => row.split(" ")[0])).toEqual(["iris", "penguins", "weather"])
    );
  });

  it("shows twenty resources at a time, and more on request", async () => {
    for (let number = 1; number <= 25; number++)
      addDataset(db, { name: `batch-${number}`, creationTime: nov12 + number });
    const { user } = renderDatasets();
    expect(await rows()).toHaveLength(20);

    await user.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(async () => expect(await rows()).toHaveLength(25));
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("says what to do when the user has no resource of the kind yet", async () => {
    renderDatasets();

    expect(await screen.findByText("No datasets yet")).toBeInTheDocument();
    expect(screen.getByText("Create a dataset to upload files.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it.each([
    [
      "fails",
      () =>
        HttpResponse.json(
          { code: 500, message: "There was an error processing your request. It has been logged (ID 1f2e)." },
          { status: 500 }
        ),
      "There was an error processing your request.",
    ],
    [
      "sends an answer that cannot be read",
      () => HttpResponse.text("{"),
      "The server sent a response that could not be read.",
    ],
  ])("shows an error when the search %s", async (_, response, message) => {
    server.use(http.get("/api/dashboard/search", response));

    renderDatasets();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("list", { name: "Datasets" })).not.toBeInTheDocument();
  });

  it("offers each row's actions by what the user may do: an owner shares and deletes, an editor shares, a viewer neither", async () => {
    addDataset(db, { name: "mine" });
    addDataset(db, { name: "editable", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "WRITE" }] });
    addDataset(db, { name: "viewable", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "READ" }] });
    const { user } = renderDatasets();

    const menuOfMine = await openMenu(user, "mine");
    expect(
      within(menuOfMine)
        .getAllByRole("menuitem")
        .map(item => item.textContent)
    ).toEqual(["Share", "Delete"]);
    await user.keyboard("{Escape}");

    const menuOfEditable = await openMenu(user, "editable");
    expect(
      within(menuOfEditable)
        .getAllByRole("menuitem")
        .map(item => item.textContent)
    ).toEqual(["Share"]);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "More actions for viewable" })).not.toBeInTheDocument();
  });

  it("shares a resource from its row's menu", async () => {
    addDataset(db, { name: "iris" });
    const { user } = renderDatasets();

    await user.click(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Share" }));

    expect(await screen.findByRole("dialog", { name: "Share iris" })).toBeInTheDocument();
  });

  it("deletes a resource from its row's menu after asking, and lists the rest", async () => {
    addDataset(db, { name: "iris" });
    addDataset(db, { name: "penguins" });
    const { user } = renderDatasets();

    await user.click(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete iris?" });
    expect(dialog).toHaveTextContent("Its versions and files are deleted too. This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await rows()).toEqual(["penguins Private texera · Nov 12, 2026"]);
  });

  it("keeps the resource when the deletion is cancelled", async () => {
    addDataset(db, { name: "iris" });
    const { user } = renderDatasets();

    await user.click(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(db.datasets).toHaveLength(1);
  });

  it("shows why a resource could not be deleted, until the dialog is opened again", async () => {
    addDataset(db, { name: "iris" });
    const failing: ResourceDeletion = { run: () => Promise.reject(new Error("The dataset is in use.")) };
    const { user } = renderWithProviders(
      <ResourceListPage
        kind="dataset"
        deletion={failing}
        emptyDescription="None yet."
      />,
      { session: sessionFor(admin) }
    );

    await user.click(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The dataset is in use.");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Delete" }));

    expect(within(await screen.findByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the same resources as cards, with the same menus, and opens the next list as the user left it", async () => {
    addDataset(db, { name: "iris", description: "Iris flowers" });
    const { user, unmount } = renderDatasets();
    const asRows = await rows();

    await user.click(screen.getByRole("radio", { name: "Cards" }));

    expect(screen.getByRole("radio", { name: "Cards" })).toBeChecked();
    expect(await rows()).toEqual(asRows);
    expect(within(await openMenu(user, "iris")).getByRole("menuitem", { name: "Share" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    unmount();
    renderDatasets();
    expect(await screen.findByRole("radio", { name: "Cards" })).toBeChecked();
  });
});
