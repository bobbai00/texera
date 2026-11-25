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
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import {
  createDataset,
  createVersion,
  datasetDeletion,
  datasetQuery,
  fileTreeQuery,
  uploadFile,
  versionListQuery,
} from "./api";

const mebibyte = 1024 * 1024;

beforeEach(() => {
  signInAs(admin);
});

/** The dataset as a page loads it: what uploadFile is given. */
function loadDataset(did: number) {
  return new QueryClient().fetchQuery(datasetQuery(did));
}

/** Records the calls of uploads, such as "init" or "part 1", and lets the fake backend answer them. */
function recordUploadCalls(): string[] {
  const calls: string[] = [];
  server.use(
    http.post("/api/dataset/multipart-upload*", ({ request }) => {
      const query = new URL(request.url).searchParams;
      calls.push(query.get("type") ?? `part ${query.get("partNumber")}`);
    })
  );
  return calls;
}

describe("the dataset queries", () => {
  it("load a dataset as a resource, its versions newest first, and the files of a version", async () => {
    const { did, versions } = addDataset(db, {
      name: "iris",
      versions: [
        { name: "v1", files: { "iris.csv": "5.1,setosa\n" } },
        { name: "v2 - add notes", files: { "iris.csv": "5.1,setosa\n", "notes/README.md": "# Iris\n" } },
      ],
    });

    const queryClient = new QueryClient();

    expect(await loadDataset(did)).toEqual({
      kind: "dataset",
      id: did,
      name: "iris",
      description: "",
      owner: "texera",
      isPublic: false,
      createdAt: Date.UTC(2026, 10, 12, 12),
      access: "owner",
    });
    expect(await queryClient.fetchQuery(versionListQuery(did))).toEqual([
      { id: versions[1].dvid, name: "v2 - add notes", createdAt: versions[1].creationTime },
      { id: versions[0].dvid, name: "v1", createdAt: versions[0].creationTime },
    ]);
    expect(await queryClient.fetchQuery(fileTreeQuery(did, versions[1].dvid))).toEqual([
      {
        type: "directory",
        name: "notes",
        parentDir: "/dataset/texera/iris/v2 - add notes",
        children: [
          { type: "file", name: "README.md", parentDir: "/dataset/texera/iris/v2 - add notes/notes", size: 7 },
        ],
      },
      { type: "file", name: "iris.csv", parentDir: "/dataset/texera/iris/v2 - add notes", size: 11 },
    ]);
  });
});

describe("createDataset", () => {
  it("asks for a dataset that people may download, with the name, description and visibility given", async () => {
    const requests: Request[] = [];
    server.use(http.post("/api/dataset/create", ({ request }) => void requests.push(request.clone())));

    const created = await createDataset({ name: "iris", description: "Iris flowers", isPublic: true });

    expect(await requests[0].json()).toEqual({
      datasetName: "iris",
      datasetDescription: "Iris flowers",
      isDatasetPublic: true,
      isDatasetDownloadable: true,
    });
    expect(created).toMatchObject({ kind: "dataset", name: "iris", isPublic: true, access: "owner" });
  });

  it("fails with the server's message when the user has a dataset of that name", async () => {
    addDataset(db, { name: "iris" });

    await expect(createDataset({ name: "iris", description: "", isPublic: false })).rejects.toThrow(
      "Dataset with the same name already exists"
    );
  });
});

describe("datasetDeletion", () => {
  it("deletes the dataset", async () => {
    const { did } = addDataset(db, { name: "iris" });

    await datasetDeletion.run(did);

    expect(db.datasets).toEqual([]);
  });

  it("fails with the server's message when the user does not own the dataset", async () => {
    const { did } = addDataset(db, {
      name: "iris",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "WRITE" }],
    });

    await expect(datasetDeletion.run(did)).rejects.toThrow("User has no access to this dataset");
    expect(db.datasets).toHaveLength(1);
  });
});

describe("uploadFile", () => {
  it("stages a file: starts a multipart upload, sends the file, and finishes the upload", async () => {
    const iris = addDataset(db, { name: "iris" });
    const calls = recordUploadCalls();

    await uploadFile(await loadDataset(iris.did), new File(["5.1,setosa\n"], "iris.csv"));

    expect(calls).toEqual(["init", "part 1", "finish"]);
    expect(new TextDecoder().decode(iris.staged["iris.csv"])).toBe("5.1,setosa\n");
  });

  it("sends a file larger than 50 MiB in parts of 50 MiB", async () => {
    // An admin may allow files of this size: by default the server takes at most 20 MiB.
    db.settings.dataset_single_file_upload_max_size_mib = "100";
    const scans = addDataset(db, { name: "scans" });
    const calls = recordUploadCalls();
    const size = 50 * mebibyte + 3;

    await uploadFile(await loadDataset(scans.did), new File([new Uint8Array(size)], "scan.bin"));

    expect(calls).toEqual(["init", "part 1", "part 2", "finish"]);
    expect(scans.staged["scan.bin"].byteLength).toBe(size);
  });

  it("starts an earlier unfinished upload of the same name and size over, so the file keeps its own bytes", async () => {
    const iris = addDataset(db, { name: "iris" });
    // The server would resume this upload, and finish it with the part it holds, unless told to start over.
    const earlier = new TextEncoder().encode("OLD-DATA");
    iris.uploads["report.csv"] = { fileSize: earlier.byteLength, partSize: 50 * mebibyte, parts: { 1: earlier } };
    const calls = recordUploadCalls();

    await uploadFile(await loadDataset(iris.did), new File(["NEW-DATA"], "report.csv"));

    expect(calls).toEqual(["init", "part 1", "finish"]);
    expect(new TextDecoder().decode(iris.staged["report.csv"])).toBe("NEW-DATA");
  });

  it.each(["iris data.csv", "sepal+petal.csv", "100%.csv", "Blütenblätter.csv"])(
    "keeps the file name %j as it is, though the server decodes it twice",
    async name => {
      const iris = addDataset(db, { name: "iris" });

      await uploadFile(await loadDataset(iris.did), new File(["5.1"], name));

      expect(Object.keys(iris.staged)).toEqual([name]);
    }
  );

  it("cancels the upload when a part fails, and fails with the server's message", async () => {
    const iris = addDataset(db, { name: "iris" });
    server.use(
      http.post("/api/dataset/multipart-upload/part", () =>
        HttpResponse.json({ code: 500, message: "Failed to upload part 1 to S3" }, { status: 500 })
      )
    );
    const calls = recordUploadCalls();

    await expect(uploadFile(await loadDataset(iris.did), new File(["5.1"], "iris.csv"))).rejects.toThrow(
      "Failed to upload part 1 to S3"
    );

    expect(calls).toEqual(["init", "part 1", "abort"]);
    expect(iris.uploads).toEqual({});
    expect(iris.staged).toEqual({});
  });

  it("leaves alone an upload it could not start, which may be someone else's", async () => {
    const iris = addDataset(db, { name: "iris" });
    server.use(
      http.post("/api/dataset/multipart-upload", () =>
        HttpResponse.json({ code: 409, message: "Another client is uploading this file" }, { status: 409 })
      )
    );
    const calls = recordUploadCalls();

    await expect(uploadFile(await loadDataset(iris.did), new File(["5.1"], "iris.csv"))).rejects.toThrow(
      "Another client is uploading this file"
    );

    expect(calls).toEqual(["init"]);
  });
});

describe("createVersion", () => {
  it("makes a version of the staged files, named after its description", async () => {
    const iris = addDataset(db, { name: "iris", versions: [{ name: "v1", files: { "iris.csv": "5.1" } }] });
    iris.staged["notes.md"] = new TextEncoder().encode("# Iris");

    const version = await createVersion(iris.did, "add notes");

    expect(version).toMatchObject({ id: iris.versions[1].dvid, name: "v2 - add notes" });
    expect(Object.keys(iris.versions[1].files)).toEqual(["iris.csv", "notes.md"]);
  });

  it("names a version without a description by its number", async () => {
    const iris = addDataset(db, { name: "iris" });
    iris.staged["iris.csv"] = new TextEncoder().encode("5.1");

    await expect(createVersion(iris.did, "")).resolves.toMatchObject({ name: "v1" });
  });

  it("fails with the server's message when no file was added since the last version", async () => {
    const iris = addDataset(db, { name: "iris" });

    await expect(createVersion(iris.did, "nothing new")).rejects.toThrow(
      "No changes detected in dataset. Version creation aborted."
    );
  });
});
