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

import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it, vi } from "vitest";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { datasetQuery } from "../api";
import { NewVersionDialog } from "./new-version-dialog";

const mebibyte = 1024 * 1024;
const irisCsv = new File(["sepal_length,species\n5.1,setosa\n"], "iris.csv", { type: "text/csv" });
const readme = new File(["# Iris\n"], "README.md", { type: "text/markdown" });

/** Opens the dialog for a new version of the admin's dataset "iris" from its button. */
async function openNewVersionDialog(onVersionCreated = vi.fn()) {
  const iris = addDataset(db, { name: "iris" });
  signInAs(admin);
  const dataset = await new QueryClient().fetchQuery(datasetQuery(iris.did));
  const rendered = renderWithProviders(
    <NewVersionDialog
      dataset={dataset}
      onVersionCreated={onVersionCreated}
    />
  );
  await rendered.user.click(screen.getByRole("button", { name: "New version" }));
  return { ...rendered, iris, onVersionCreated };
}

/** The rows of the files being added, each as its text. */
function uploads() {
  const list = screen.getByRole("list", { name: "Uploads" });
  return within(list)
    .getAllByRole("listitem")
    .map(row => row.textContent);
}

function createVersionButton() {
  return screen.getByRole("button", { name: "Create version" });
}

describe("NewVersionDialog", () => {
  it("opens from its button, named after the dataset", async () => {
    await openNewVersionDialog();

    expect(screen.getByRole("dialog", { name: "New version of iris" })).toBeInTheDocument();
  });

  it("uploads each file it is given and shows it as uploaded", async () => {
    const { user, iris } = await openNewVersionDialog();

    await user.upload(screen.getByLabelText("Add files"), [irisCsv, readme]);

    await waitFor(() => expect(uploads()).toEqual(["iris.csv Uploaded", "README.md Uploaded"]));
    expect(Object.keys(iris.staged).sort()).toEqual(["README.md", "iris.csv"]);
    expect(createVersionButton()).toBeEnabled();
  });

  it("tells screen readers how an upload is going", async () => {
    const { user } = await openNewVersionDialog();

    await user.upload(screen.getByLabelText("Add files"), irisCsv);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded"));
  });

  it("shows a file as uploading until the server has it, and lets a version be made only when none is", async () => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => (finish = resolve));
    server.use(
      http.post("/api/dataset/multipart-upload", async ({ request }) => {
        // Holds the last call of README.md's upload, then lets the fake backend answer it.
        const query = new URL(request.url).searchParams;
        if (query.get("type") === "finish" && query.get("filePath") === "README.md") await finished;
      })
    );
    const { user } = await openNewVersionDialog();
    expect(createVersionButton()).toBeDisabled();
    await user.upload(screen.getByLabelText("Add files"), irisCsv);
    await waitFor(() => expect(uploads()).toEqual(["iris.csv Uploaded"]));
    expect(createVersionButton()).toBeEnabled();

    await user.upload(screen.getByLabelText("Add files"), readme);

    expect(uploads()).toEqual(["iris.csv Uploaded", "README.md Uploading…"]);
    expect(createVersionButton()).toBeDisabled();
    finish();
    await waitFor(() => expect(uploads()).toEqual(["iris.csv Uploaded", "README.md Uploaded"]));
    expect(createVersionButton()).toBeEnabled();
  });

  it("shows why a file failed, cancels its upload, and makes no version of it", async () => {
    server.use(
      http.post("/api/dataset/multipart-upload/part", () =>
        HttpResponse.json({ code: 500, message: "Failed to upload part 1 to S3" }, { status: 500 })
      )
    );
    const { user, iris } = await openNewVersionDialog();

    await user.upload(screen.getByLabelText("Add files"), irisCsv);

    await waitFor(() => expect(uploads()).toEqual(["iris.csv Failed: Failed to upload part 1 to S3"]));
    expect(iris.uploads).toEqual({});
    expect(createVersionButton()).toBeDisabled();
  });

  it("cancels an upload when the dialog is closed, so the file is not added", async () => {
    let sendPart!: () => void;
    const partHeld = new Promise<void>(resolve => (sendPart = resolve));
    const calls: string[] = [];
    server.use(
      http.post("/api/dataset/multipart-upload*", async ({ request }) => {
        const call = new URL(request.url).searchParams.get("type") ?? "part";
        calls.push(call);
        if (call === "part") await partHeld;
      })
    );
    const { user, iris } = await openNewVersionDialog();
    await user.upload(screen.getByLabelText("Add files"), irisCsv);
    await waitFor(() => expect(calls).toEqual(["init", "part"]));

    await user.click(screen.getByRole("button", { name: "Close" }));
    sendPart();

    await waitFor(() => expect(calls).toEqual(["init", "part", "abort"]));
    expect(iris.staged).toEqual({});
  });

  it("explains that an empty file cannot be added", async () => {
    const { user } = await openNewVersionDialog();

    await user.upload(screen.getByLabelText("Add files"), new File([], "empty.csv"));

    await waitFor(() => expect(uploads()).toEqual(["empty.csv Failed: This file is empty."]));
  });

  it("explains that a file over the size limit an admin set cannot be added, and takes one at the limit", async () => {
    db.settings.dataset_single_file_upload_max_size_mib = "1";
    const { user } = await openNewVersionDialog();

    await user.upload(screen.getByLabelText("Add files"), [
      new File([new Uint8Array(mebibyte + 1)], "too-big.bin"),
      new File([new Uint8Array(mebibyte)], "just-fits.bin"),
    ]);

    await waitFor(() =>
      expect(uploads()).toEqual(["too-big.bin Failed: Files can be at most 1 MB.", "just-fits.bin Uploaded"])
    );
  });

  it("makes a version of the uploaded files with the description, reports it, closes, and starts over", async () => {
    const { user, iris, onVersionCreated } = await openNewVersionDialog();
    await user.upload(screen.getByLabelText("Add files"), [irisCsv, readme]);
    await user.type(screen.getByLabelText("Version description"), "first measurements");
    await waitFor(() => expect(createVersionButton()).toBeEnabled());

    await user.click(createVersionButton());

    await waitFor(() => expect(onVersionCreated).toHaveBeenCalledExactlyOnceWith(iris.versions[0].dvid));
    expect(iris.versions[0].name).toBe("v1 - first measurements");
    expect(Object.keys(iris.versions[0].files).sort()).toEqual(["README.md", "iris.csv"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New version" }));

    expect(screen.queryByRole("list", { name: "Uploads" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Version description")).toHaveValue("");
    expect(createVersionButton()).toBeDisabled();
  });

  it("names a version without a description by its number", async () => {
    const { user, iris } = await openNewVersionDialog();
    await user.upload(screen.getByLabelText("Add files"), irisCsv);
    await waitFor(() => expect(createVersionButton()).toBeEnabled());

    await user.click(createVersionButton());

    await waitFor(() => expect(iris.versions.map(version => version.name)).toEqual(["v1"]));
  });

  it("takes no files while the version is being made, as the dialog closes after it", async () => {
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    server.use(http.post("/api/dataset/:did/version/create", () => answered));
    const { user } = await openNewVersionDialog();
    await user.upload(screen.getByLabelText("Add files"), irisCsv);
    await waitFor(() => expect(createVersionButton()).toBeEnabled());

    await user.click(createVersionButton());

    expect(screen.getByLabelText("Add files")).toBeDisabled();
    answer();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the server's message when the version cannot be made", async () => {
    const { user, iris, onVersionCreated } = await openNewVersionDialog();
    await user.upload(screen.getByLabelText("Add files"), irisCsv);
    await user.type(screen.getByLabelText("Version description"), "lengths in cm/mm");
    await waitFor(() => expect(createVersionButton()).toBeEnabled());

    await user.click(createVersionButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid version description: '/' is not allowed because the version name is part of the paths of its files."
    );
    expect(uploads()).toEqual(["iris.csv Uploaded"]);
    expect(iris.versions).toEqual([]);
    expect(onVersionCreated).not.toHaveBeenCalled();
  });
});
