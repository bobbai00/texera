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
import { delay } from "msw";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import type { ResourcePath } from "@/lib/resource-path";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { addModel } from "@/testing/mock-api/model";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";
import { spokenText } from "@/testing/text";
import type { ResourceScope } from "./api";
import { ResourceChip } from "./resource-chip";

/** A file of reader's dataset "penguins", as a workflow names it. */
const penguins: ResourcePath = {
  kind: "dataset",
  owner: reader.email,
  name: "penguins",
  version: "v1",
  file: "islands/biscoe.csv",
};
/** A version of the admin's model "resnet", as a UDF's parameter names it. */
const resnet: ResourcePath = { kind: "model", owner: admin.email, name: "resnet", version: "v3" };

/** Reader's dataset "penguins", public, with a description and two versions. */
function addPenguins() {
  return addDataset(db, {
    name: "penguins",
    description: "Palmer Archipelago penguins",
    ownerUid: reader.uid,
    isPublic: true,
    versions: [
      { name: "v1", files: { "islands/biscoe.csv": "" } },
      { name: "v2", files: { "islands/biscoe.csv": "" } },
    ],
  });
}

/** The chip of a path, signed in as the admin unless told otherwise. */
function renderChip(
  path: ResourcePath,
  { scope, signedIn = true }: { scope?: ResourceScope; signedIn?: boolean } = {}
) {
  return renderWithProviders(
    <ResourceChip
      path={path}
      scope={scope}
    />,
    { session: signedIn ? sessionFor(admin) : undefined }
  );
}

/** What the opened chip says, each by its name, as a screen reader reads it: [name, value]. */
const termsOf = (details: HTMLElement) =>
  within(details)
    .queryAllByRole("term")
    .map(term => [term.textContent, spokenText(term.nextElementSibling!)]);

/** The value of what the opened chip says by this name. */
const valueOf = (details: HTMLElement, name: string) => within(details).getByText(name).nextElementSibling!;

/** Opens the chip of a version by its name and version, and returns what it opens. */
async function open(user: ReturnType<typeof renderChip>["user"], name: string) {
  await user.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name: name.split(" ")[0] });
}

describe("ResourceChip", () => {
  it("names the version on the chip, in its kind's color, with the whole path as its title, and asks nothing yet", () => {
    const searches: Request[] = [];
    server.use(http.get("/api/dashboard/search", ({ request }) => void searches.push(request)));

    renderChip(penguins);

    const chip = screen.getByRole("button", { name: "penguins v1" });
    expect(chip).toHaveAccessibleDescription("/dataset/reader@example.com/penguins/v1/islands/biscoe.csv");
    expect(chip).toHaveClass("border-dashed", "border-kind-dataset", "text-xs");
    expect(chip.querySelector("svg")).toHaveClass("text-kind-dataset");
    expect(searches).toEqual([]);
  });

  it("draws a model's version in the model's color", () => {
    renderChip(resnet);

    const chip = screen.getByRole("button", { name: "resnet v3" });
    expect(chip).toHaveClass("border-kind-model");
    expect(chip.querySelector("svg")).toHaveClass("text-kind-model");
  });

  it("opens what its path says and what the backend says of a dataset, with a link to the file in its version", async () => {
    const { did, versions } = addPenguins();
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    expect(details).toHaveTextContent("Dataset · v1");
    expect(termsOf(details)).toEqual([
      ["File", "islands/biscoe.csv"],
      ["Owner", "reader@example.com"],
    ]);
    expect(await within(details).findByText("Palmer Archipelago penguins")).toBeInTheDocument();
    expect(await within(details).findByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/datasets/${did}?version=${versions[0].dvid}&file=islands%2Fbiscoe.csv`
    );
  });

  /** Holds the search's answer back until `answer` is called, so that a test sees what is shown meanwhile. */
  function holdTheSearch() {
    let answer = () => {};
    const answered = new Promise<void>(resolve => (answer = resolve));
    // Once answered, the fake backend answers as ever.
    server.use(http.get("/api/dashboard/search", async () => void (await answered)));
    return answer;
  }

  it("says it is looking while the backend is asked", async () => {
    addPenguins();
    const answer = holdTheSearch();
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    expect(within(details).getByText("Looking it up…")).toBeInTheDocument();
    answer();
    await within(details).findByRole("link", { name: "Open" });
    expect(within(details).queryByText("Looking it up…")).not.toBeInTheDocument();
  });

  it("says how the lookup ends where it said it was looking, which a screen reader reads out once it changes", async () => {
    const { did, versions } = addPenguins();
    const answer = holdTheSearch();
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    const status = within(details).getByRole("status");
    expect(status).toHaveTextContent("Looking it up…");
    answer();
    // Once, with all of it: the dataset is found, and its version, which is opened there.
    expect(await within(status).findByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/datasets/${did}?version=${versions[0].dvid}&file=islands%2Fbiscoe.csv`
    );
    expect(status).toHaveTextContent("Palmer Archipelago penguins");
    expect(status).not.toHaveTextContent("Looking it up…");
    expect(within(details).getByRole("status")).toBe(status);
  });

  it("draws the owner as a person, by their initials beside their email", async () => {
    addPenguins();
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    const owner = valueOf(details, "Owner");
    expect(spokenText(owner)).toBe("reader@example.com");
    expect(owner.querySelector("[data-slot=avatar]")).toHaveTextContent("R");
  });

  it("spells out the whole path, wrapping what is long rather than cutting it short, as nothing else spells it", async () => {
    const long = {
      ...penguins,
      name: "palmer-archipelago-penguins-by-island-and-year",
      file: "islands/biscoe/2023/measurements-of-every-adult-penguin.csv",
    };
    const { user } = renderChip(long);

    const details = await open(user, `${long.name} v1`);

    // jsdom lays nothing out: what it tells is that the values may take more than a line.
    for (const value of [valueOf(details, "File"), valueOf(details, "Owner"), within(details).getByText(long.name)]) {
      expect(value).toHaveClass("wrap-anywhere");
      expect(value).not.toHaveClass("truncate");
    }
  });

  it("shows which chip has the keyboard by a ring as strong as the app's other rings", () => {
    renderChip(penguins);

    // As strong against the canvas as a focus ring needs, in both themes, where a faded one is not.
    expect(screen.getByRole("button", { name: "penguins v1" })).toHaveClass(
      "focus-visible:ring-2",
      "focus-visible:ring-ring"
    );
  });

  it("opens what a model was made with and how it is saved, with a link to its page in the other app", async () => {
    const { mid } = addModel(db, { name: "resnet", framework: "PyTorch", format: "safetensors" });
    const { user } = renderChip(resnet);

    const details = await open(user, "resnet v3");

    expect(details).toHaveTextContent("Model · v3");
    expect(await within(details).findByRole("link", { name: "Open" })).toHaveAttribute("href", `/user/model/${mid}`);
    // A model's version is read as a whole: it names no file.
    expect(termsOf(details)).toEqual([
      ["Owner", "texera"],
      ["Framework", "PyTorch"],
      ["Format", "safetensors"],
    ]);
  });

  it("says it found nothing the user may read, and offers nothing to open", async () => {
    addDataset(db, { name: "penguins", ownerUid: reader.uid });
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    const status = within(details).getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Not found, or you cannot read it."));
    expect(termsOf(details)).toContainEqual(["Owner", "reader@example.com"]);
    expect(within(details).queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens the dataset's page where it has no version of that name any more, and says so", async () => {
    const { did } = addPenguins();
    const { user } = renderChip({ ...penguins, version: "v9" });

    const details = await open(user, "penguins v9");

    const status = within(details).getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("It has no version named v9."));
    expect(within(status).getByRole("link", { name: "Open" })).toHaveAttribute("href", `/datasets/${did}`);
  });

  it("finds a public one through the public search for whoever is not signed in, as the hub does", async () => {
    const { did, versions } = addPenguins();
    const { user } = renderChip(penguins, { scope: "public", signedIn: false });

    const details = await open(user, "penguins v1");

    expect(await within(details).findByText("Palmer Archipelago penguins")).toBeInTheDocument();
    expect(await within(details).findByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/datasets/${did}?version=${versions[0].dvid}&file=islands%2Fbiscoe.csv`
    );
  });

  it.each([
    ["the search fails", "/api/dashboard/search", "The search is down"],
    ["the versions cannot be listed", "/api/dataset/:did/version/list", "LakeFS is down"],
  ])("says why when %s", async (_, path, message) => {
    addPenguins();
    server.use(http.get(path, () => HttpResponse.json({ code: 500, message }, { status: 500 })));
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    expect(await within(details).findByRole("alert")).toHaveTextContent(message);
    expect(within(details).queryByRole("link")).not.toBeInTheDocument();
  });

  it("stops looking once it is closed", async () => {
    const asked: Request[] = [];
    server.use(
      http.get("/api/dashboard/search", async ({ request }) => {
        asked.push(request);
        await delay("infinite");
      })
    );
    const { user } = renderChip(penguins);
    await open(user, "penguins v1");
    await waitFor(() => expect(asked).toHaveLength(1));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(asked[0].signal.aborted).toBe(true));
  });

  it("says why when the search sends an answer that cannot be read", async () => {
    server.use(http.get("/api/dashboard/search", () => HttpResponse.text("{")));
    const { user } = renderChip(penguins);

    const details = await open(user, "penguins v1");

    expect(await within(details).findByRole("alert")).toHaveTextContent("could not be read");
  });

  it("closes with Escape, and gives the keyboard back to the chip", async () => {
    addPenguins();
    const { user } = renderChip(penguins);
    await open(user, "penguins v1");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "penguins v1" })).toHaveFocus();
  });
});
