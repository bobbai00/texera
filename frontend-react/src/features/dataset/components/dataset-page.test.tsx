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
import type { UserEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { recordDownloads } from "@/testing/download";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset, type DatasetSeed, type MockDataset } from "@/testing/mock-api/dataset";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor, signInAs } from "@/testing/session";

const irisCsv = "sepal_length,species\n5.1,setosa\n";
const readme = "# Iris\n";

/** The admin's dataset "iris": v1 has iris.csv, and v2 adds abstract.txt and notes/README.md. */
function addIris(seed: Partial<DatasetSeed> = {}) {
  return addDataset(db, {
    name: "iris",
    description: "Measurements of 150 iris flowers",
    versions: [
      { name: "v1", files: { "iris.csv": irisCsv } },
      {
        name: "v2 - add notes",
        files: { "iris.csv": irisCsv, "abstract.txt": "Fisher, 1936\n", "notes/README.md": readme },
      },
    ],
    ...seed,
  });
}

function filesSection() {
  return screen.getByRole("region", { name: "Files" });
}

/** The names of the files on the page, in the order shown. */
function fileNames() {
  return within(filesSection())
    .queryAllByRole("button", { name: /^Download / })
    .map(button => button.getAttribute("aria-label")?.replace("Download ", ""));
}

/** The picker of the version the page shows. */
function versionPicker() {
  return screen.findByRole("combobox", { name: "Version" });
}

/** Chooses "Delete" in the menu of the dataset "iris". */
async function chooseDelete(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "More actions for iris" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  return screen.findByRole("dialog", { name: "Delete iris?" });
}

/** Opens the dialog that makes a new version. */
async function openNewVersion(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "New version" }));
  return screen.findByRole("dialog", { name: /^New version of / });
}

describe("DatasetPage", () => {
  it("shows the dataset's name, description, visibility, owner and date, and what the user may do with it", async () => {
    const iris = addIris();

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { level: 1, name: "iris" })).toBeInTheDocument();
    expect(screen.getByText("Measurements of 150 iris flowers")).toBeInTheDocument();
    expect(screen.getByText("Owner: texera · Created Nov 12, 2026")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Datasets" })).toHaveAttribute("href", "/datasets");
  });

  it("shows the newest version, with its files in their folders: folders first, then by name", async () => {
    const iris = addIris();

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await versionPicker()).toHaveTextContent(/^v2 - add notes/);
    expect(fileNames()).toEqual(["README.md", "abstract.txt", "iris.csv"]);
    const notes = within(filesSection()).getByRole("list", { name: "notes" });
    expect(within(notes).getByRole("listitem")).toHaveTextContent("README.md 7 B");
    expect(within(filesSection()).getByText("32 B")).toBeInTheDocument();
  });

  it("shows the version that the address names", async () => {
    const iris = addIris();

    renderApp(`/datasets/${iris.did}?version=${iris.versions[0].dvid}`, { session: sessionFor(admin) });

    expect(await versionPicker()).toHaveTextContent(/^v1/);
    expect(fileNames()).toEqual(["iris.csv"]);
  });

  it.each([
    ["a version of another dataset", (other: MockDataset) => String(other.versions[0].dvid)],
    ["a version that is not a number", () => "newest"],
  ])("shows the newest version when the address names %s", async (_, version) => {
    const iris = addIris();
    const penguins = addDataset(db, { name: "penguins", versions: [{ name: "v1", files: { "penguins.csv": "" } }] });

    renderApp(`/datasets/${iris.did}?version=${version(penguins)}`, { session: sessionFor(admin) });

    expect(await versionPicker()).toHaveTextContent(/^v2 - add notes/);
    expect(fileNames()).toEqual(["README.md", "abstract.txt", "iris.csv"]);
  });

  it("shows the version that is chosen, and puts it in the address", async () => {
    const iris = addIris();
    const { user, router } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await user.click(await versionPicker());
    await user.click(await screen.findByRole("option", { name: /^v1 / }));

    await waitFor(() => expect(fileNames()).toEqual(["iris.csv"]));
    expect(await versionPicker()).toHaveTextContent(/^v1/);
    expect(router.state.location.search).toEqual({ version: iris.versions[0].dvid });
  });

  it("says so when the dataset has no versions yet", async () => {
    const iris = addDataset(db, { name: "iris" });

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await screen.findByText("No versions yet")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
  });

  it("says so when a version has no files", async () => {
    const iris = addDataset(db, { name: "iris", versions: [{ name: "v1 - remove every file", files: {} }] });

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await screen.findByText("This version has no files")).toBeInTheDocument();
  });

  it("downloads a file under its name, also when its path has spaces, a + or a %", async () => {
    const saved = recordDownloads();
    const iris = addDataset(db, {
      name: "iris",
      versions: [{ name: "v1 - 50% sample", files: { "sepal+petal.csv": irisCsv } }],
    });
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "Download sepal+petal.csv" }));

    await waitFor(() => expect(saved.map(file => file.fileName)).toEqual(["sepal+petal.csv"]));
    expect(await saved[0].blob.text()).toBe(irisCsv);
  });

  it("shows the server's message when a file cannot be downloaded", async () => {
    server.use(
      http.get("/api/dataset/presign-download", ({ request }) => {
        // Only iris.csv fails: the file shown first, notes/README.md, is read as usual.
        if (!new URL(request.url).searchParams.get("filePath")?.includes("iris.csv")) return;
        return HttpResponse.json(
          { message: "Error while generating a presigned URL for file 'iris.csv'" },
          { status: 500 }
        );
      })
    );
    const iris = addIris();
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "Download iris.csv" }));

    expect(await within(filesSection()).findByRole("alert")).toHaveTextContent(
      "Error while generating a presigned URL for file 'iris.csv'"
    );
  });

  it("makes a version of uploaded files, then shows it", async () => {
    const iris = addIris();
    const { user, router } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await openNewVersion(user);
    await user.upload(screen.getByLabelText("Add files"), new File(["species,island\n"], "penguins.csv"));
    await user.type(screen.getByLabelText("Version description"), "penguins");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create version" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Create version" }));

    await waitFor(() => expect(fileNames()).toEqual(["README.md", "abstract.txt", "iris.csv", "penguins.csv"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await versionPicker()).toHaveTextContent(/^v3 - penguins/);
    expect(router.state.location.search).toEqual({ version: iris.versions[2].dvid });
  });

  it("keeps the files picked for one dataset off the page of another", async () => {
    const iris = addIris();
    const penguins = addDataset(db, { name: "penguins" });
    const { user, router } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });
    await openNewVersion(user);
    await user.upload(screen.getByLabelText("Add files"), new File(["5.1"], "iris.csv"));
    await screen.findByRole("list", { name: "Uploads" });

    await router.navigate({ to: "/datasets/$datasetId", params: { datasetId: penguins.did } });

    expect(await screen.findByRole("heading", { level: 1, name: "penguins" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Uploads" })).not.toBeInTheDocument();
  });

  it("keeps the files one user picked off the page of the next, when another tab signs in as someone else", async () => {
    const iris = addIris({ grants: [{ uid: reader.uid, privilege: "WRITE" }] });
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });
    await openNewVersion(user);
    await user.upload(screen.getByLabelText("Add files"), new File(["5.1"], "iris.csv"));
    await screen.findByRole("list", { name: "Uploads" });

    // The other tab signs in, and this tab hears of it through a storage event.
    signInAs(reader);
    window.dispatchEvent(new StorageEvent("storage", { key: "access_token" }));

    await waitFor(() => expect(screen.getByRole("banner")).toHaveTextContent(reader.name));
    expect(await screen.findByRole("button", { name: "New version" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Uploads" })).not.toBeInTheDocument();
  });

  it("opens the share dialog", async () => {
    const iris = addIris();
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "Share" }));

    expect(screen.getByRole("dialog", { name: "Share iris" })).toBeInTheDocument();
  });

  it("deletes the dataset after asking, then opens the datasets, which no longer list it", async () => {
    addIris();
    const { user, router } = renderApp("/datasets", { session: sessionFor(admin) });
    await user.click(await screen.findByRole("link", { name: "iris" }));

    const dialog = await chooseDelete(user);
    expect(dialog).toHaveTextContent("Its versions and files are deleted too. This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No datasets yet")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/datasets");
    expect(db.datasets).toEqual([]);
  });

  it("keeps the dataset when the deletion is cancelled", async () => {
    const iris = addIris();
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    const dialog = await chooseDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "iris" })).toBeInTheDocument();
    expect(db.datasets).toHaveLength(1);
  });

  it("shows the server's message when the dataset cannot be deleted", async () => {
    server.use(
      http.delete("/api/dataset/:did", () =>
        HttpResponse.json({ message: "Error while deleting the repository of dataset 'iris'" }, { status: 503 })
      )
    );
    const iris = addIris();
    const { user } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    const dialog = await chooseDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Error while deleting the repository of dataset 'iris'"
    );
    expect(db.datasets).toHaveLength(1);
  });

  it.each([
    ["it is shared with them to view", { grants: [{ uid: reader.uid, privilege: "READ" as const }] }],
    ["it is public", { isPublic: true }],
  ])("lets someone view but not change the dataset when %s", async (_, seed) => {
    const iris = addIris(seed);

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(reader) });

    expect(await screen.findByRole("heading", { level: 1, name: "iris" })).toBeInTheDocument();
    expect(fileNames()).toEqual(["README.md", "abstract.txt", "iris.csv"]);
    expect(screen.getByText("Can view")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for iris" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New version" })).not.toBeInTheDocument();
  });

  it("lets someone who may edit the dataset share it and add versions, but not delete it", async () => {
    const iris = addIris({ grants: [{ uid: reader.uid, privilege: "WRITE" }] });

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(reader) });

    expect(await screen.findByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByText("Can edit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New version" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for iris" })).not.toBeInTheDocument();
  });

  it("shows the server's message when the dataset does not exist", async () => {
    renderApp("/datasets/99", { session: sessionFor(admin) });

    expect(await screen.findByRole("alert")).toHaveTextContent("Dataset 99 not found");
  });

  it("shows the server's message when the user may not see the dataset", async () => {
    const iris = addIris({ ownerUid: reader.uid });

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await screen.findByRole("alert")).toHaveTextContent("User has no access to this dataset");
  });

  it("finds no page for an address whose dataset id is not a number", async () => {
    renderApp("/datasets/iris", { session: sessionFor(admin) });

    expect(await screen.findByText("This page does not exist.")).toBeInTheDocument();
  });
});

describe("what is in a file of a dataset", () => {
  const preview = (name: string) => screen.findByRole("region", { name: `Preview of ${name}` });

  it("shows the file the user chooses as its kind reads best: a CSV file as a table of its rows", async () => {
    const iris = addIris();
    const { user, router } = renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "iris.csv" }));

    const rows = await within(await preview("iris.csv")).findByRole("table", { name: "Rows of iris.csv" });
    expect(
      within(rows)
        .getAllByRole("row")
        .map(row => row.textContent)
    ).toEqual(["#sepal_lengthspecies", "15.1setosa"]);
    expect(screen.getByRole("button", { name: "iris.csv" })).toHaveAttribute("aria-current", "true");
    expect(router.state.location.search).toEqual({ file: "iris.csv" });
  });

  it("opens on the version's README, and shows Markdown formatted", async () => {
    const dataset = addDataset(db, {
      name: "penguins",
      versions: [
        { name: "v1", files: { "adelie.csv": "species\nAdelie\n", "README.md": "# Penguins\n\nFrom *Palmer*." } },
      ],
    });

    renderApp(`/datasets/${dataset.did}`, { session: sessionFor(admin) });

    const text = await within(await preview("README.md")).findByRole("article", { name: "Text of README.md" });
    expect(within(text).getByRole("heading", { level: 1 })).toHaveTextContent("Penguins");
    expect(within(text).getByText("Palmer").tagName).toBe("EM");
  });

  it("opens on the first file where the version has no README at its top", async () => {
    const iris = addIris();

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    // Folders come first, so the first file is the README in notes/.
    expect(await preview("README.md")).toBeVisible();
  });

  it("shows text highlighted as its language, and what part of a big one is shown", async () => {
    const dataset = addDataset(db, {
      name: "logs",
      versions: [{ name: "v1", files: { "server.log": "a line of a log\n".repeat(140_000) } }],
    });

    renderApp(`/datasets/${dataset.did}?file=server.log`, { session: sessionFor(admin) });

    const shown = await preview("server.log");
    expect(await within(shown).findByRole("textbox", { name: "Text of server.log" })).toHaveTextContent(
      "a line of a log"
    );
    expect(shown).toHaveTextContent("The first 1 MB of 2.1 MB.");
  });

  it("offers a file it cannot show to download", async () => {
    const dataset = addDataset(db, {
      name: "weights",
      versions: [{ name: "v1", files: { "weights.parquet": "PAR1" } }],
    });
    const downloads = recordDownloads();
    const { user } = renderApp(`/datasets/${dataset.did}`, { session: sessionFor(admin) });

    const shown = await preview("weights.parquet");
    expect(await within(shown).findByText("No preview of this kind of file")).toBeVisible();
    await user.click(within(shown).getByRole("button", { name: "Download" }));

    await waitFor(() => expect(downloads.at(-1)?.fileName).toBe("weights.parquet"));
  });

  it("keeps showing the chosen file in another version that has it, and the first in one that does not", async () => {
    const iris = addIris();
    const { router } = renderApp(`/datasets/${iris.did}?file=abstract.txt`, { session: sessionFor(admin) });
    expect(await preview("abstract.txt")).toBeVisible();

    await router.navigate({
      to: "/datasets/$datasetId",
      params: { datasetId: iris.did },
      search: { version: iris.versions[0].dvid, file: "abstract.txt" },
    });

    expect(await preview("iris.csv")).toBeVisible();
  });

  it("says why a file could not be read", async () => {
    const iris = addIris();
    server.use(
      http.get("http://storage.test/texera-dataset/:dvid", () => HttpResponse.xml("<Error/>", { status: 403 }))
    );

    renderApp(`/datasets/${iris.did}`, { session: sessionFor(admin) });

    expect(await within(await preview("README.md")).findByRole("alert")).toHaveTextContent(
      "README.md could not be read."
    );
  });
});
