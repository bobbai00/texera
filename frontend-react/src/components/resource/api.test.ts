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
import { waitFor } from "@testing-library/react";
import { delay } from "msw";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import type { ResourcePath } from "@/lib/resource-path";
import { publicKey } from "@/lib/session";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { addModel } from "@/testing/mock-api/model";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import {
  resourceKey,
  resourceListKey,
  resourceListQuery,
  resourceLookupQuery,
  sharedWithQuery,
  versionListQuery,
} from "./api";

const nov12 = Date.UTC(2026, 10, 12, 12);

beforeEach(() => {
  signInAs(admin);
});

/** The first page that the search finds. */
async function search(...[options]: Parameters<typeof resourceListQuery>) {
  const { pages } = await new QueryClient().fetchInfiniteQuery(resourceListQuery(options));
  return pages[0];
}

describe("resourceListQuery", () => {
  it("reads a dataset of the server's answer as a resource", async () => {
    const { did } = addDataset(db, { name: "iris", description: "Iris flowers", isPublic: true });

    expect(await search({ kind: "dataset" })).toEqual({
      resources: [
        {
          kind: "dataset",
          id: did,
          name: "iris",
          description: "Iris flowers",
          owner: "texera",
          isPublic: true,
          createdAt: nov12,
          access: "owner",
        },
      ],
      more: false,
    });
  });

  it("reads a model like a dataset", async () => {
    const { mid } = addModel(db, {
      name: "iris-tree",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "WRITE" }],
    });

    expect((await search({ kind: "model" })).resources).toEqual([
      {
        kind: "model",
        id: mid,
        name: "iris-tree",
        description: "",
        owner: "reader@example.com",
        isPublic: false,
        createdAt: nov12,
        access: "edit",
      },
    ]);
  });

  it("reads a workflow, whose owner the server names, and which it does not call public or private", async () => {
    const { wid } = addWorkflow(db, {
      name: "Iris classification",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "READ" }],
    });

    expect((await search({ kind: "workflow" })).resources).toEqual([
      {
        kind: "workflow",
        id: wid,
        name: "Iris classification",
        description: "",
        owner: "reader",
        createdAt: nov12,
        access: "view",
      },
    ]);
  });

  it("asks the search for one kind, the keywords, the order, and twenty resources from where the last page ended", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("/api/dashboard/search", ({ request }) => void queries.push(new URL(request.url).searchParams))
    );
    for (let number = 1; number <= 21; number++) addDataset(db, { name: `iris-${number}` });
    const queryClient = new QueryClient();
    const options = resourceListQuery({ kind: "dataset", keywords: "iris", orderBy: "NameAsc" });

    await queryClient.fetchInfiniteQuery(options);
    const { pages } = await queryClient.fetchInfiniteQuery({ ...options, pages: 2 });

    expect(Object.fromEntries(queries[0])).toEqual({
      resourceType: "dataset",
      query: "iris",
      orderBy: "NameAsc",
      start: "0",
      count: "20",
    });
    expect(queries.at(-1)?.get("start")).toBe("20");
    expect(pages.map(page => [page.resources.length, page.more])).toEqual([
      [20, true],
      [1, false],
    ]);
  });

  it("lists newest first unless told otherwise", async () => {
    addDataset(db, { name: "older", creationTime: nov12 });
    addDataset(db, { name: "newer", creationTime: nov12 + 1 });

    expect((await search({ kind: "dataset" })).resources.map(resource => resource.name)).toEqual(["newer", "older"]);
  });
});

describe("the query keys", () => {
  it("nest what is known about a resource under its key, and the lists of a kind under theirs", () => {
    const iris = { kind: "dataset", id: 12 } as const;

    expect(sharedWithQuery(iris).queryKey.slice(0, 3)).toEqual(resourceKey(iris));
    expect(resourceListQuery({ kind: "dataset" }).queryKey.slice(0, 3)).toEqual(resourceListKey("dataset"));
    expect(resourceListKey("dataset")).not.toEqual(resourceKey(iris).slice(0, 3));
  });
});

/** The path of a file of reader's dataset "penguins", as a workflow names it. */
const penguinsPath: ResourcePath = {
  kind: "dataset",
  owner: reader.email,
  name: "penguins",
  version: "v1",
  file: "penguins.csv",
};

/** What a lookup finds of the resource a path names, as a page reads it: or null. */
const lookUp = (path: ResourcePath, scope: "yours" | "public" = "yours") =>
  new QueryClient().fetchQuery(resourceLookupQuery(path, scope));

/** Records the query of each request to the search: the dashboard's, or with `public`, the hub's. */
function recordSearches(search: "search" | "publicSearch" = "search"): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(`/api/dashboard/${search}`, ({ request }) => void queries.push(new URL(request.url).searchParams))
  );
  return queries;
}

describe("resourceLookupQuery", () => {
  it("finds the dataset a path names by its owner and its name, a public one of someone else's too", async () => {
    const { did } = addDataset(db, { name: "penguins", description: "Palmer penguins", ownerUid: reader.uid });
    db.resources.find(resource => resource.type === "dataset" && resource.id === did)!.isPublic = true;
    const queries = recordSearches();

    expect(await lookUp(penguinsPath)).toEqual({
      kind: "dataset",
      id: did,
      name: "penguins",
      description: "Palmer penguins",
      owner: reader.email,
      isPublic: true,
      createdAt: nov12,
      access: "view",
    });
    // Every dataset of the owner's that the user may read, by no words: the search finds words, not names.
    expect(Object.fromEntries(queries[0])).toMatchObject({
      resourceType: "dataset",
      query: "",
      owner: reader.email,
      includePublic: "true",
    });
  });

  it("matches the name exactly, though the owner has others whose names hold it", async () => {
    addDataset(db, { name: "penguins-2023", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "READ" }] });
    addDataset(db, { name: "Penguins", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "READ" }] });
    const { did } = addDataset(db, {
      name: "penguins",
      ownerUid: reader.uid,
      grants: [{ uid: admin.uid, privilege: "READ" }],
    });

    expect(await lookUp(penguinsPath)).toMatchObject({ id: did, name: "penguins", access: "view" });
  });

  it("reads on, a page at a time, until it finds the name", async () => {
    for (let number = 1; number <= 24; number++) addDataset(db, { name: `a-${String(number).padStart(2, "0")}` });
    const { did } = addDataset(db, { name: "zebras" });
    const queries = recordSearches();

    expect(await lookUp({ ...penguinsPath, owner: admin.email, name: "zebras" })).toMatchObject({ id: did });
    expect(queries.map(query => query.get("start"))).toEqual(["0", "20"]);
  });

  it("finds a model with what it was made with and how it is saved", async () => {
    const { mid } = addModel(db, { name: "resnet", framework: "PyTorch", format: "safetensors" });

    expect(await lookUp({ kind: "model", owner: admin.email, name: "resnet", version: "v3" })).toMatchObject({
      kind: "model",
      id: mid,
      name: "resnet",
      framework: "PyTorch",
      format: "safetensors",
    });
  });

  it.each([
    [
      "a dataset of that name that the user may not read",
      () => addDataset(db, { name: "penguins", ownerUid: reader.uid }),
    ],
    ["one of that name of another owner's", () => addDataset(db, { name: "penguins", isPublic: true })],
    [
      "one of that name of another kind",
      () => addModel(db, { name: "penguins", ownerUid: reader.uid, isPublic: true }),
    ],
    ["nothing at all", () => undefined],
  ])("finds nothing where there is %s", async (_, seed) => {
    seed();

    expect(await lookUp(penguinsPath)).toBeNull();
  });

  it("finds only public ones, under the public key, for whoever is not signed in", async () => {
    localStorage.clear();
    const { did } = addDataset(db, { name: "penguins", ownerUid: reader.uid, isPublic: true });
    const queries = recordSearches("publicSearch");

    expect(await lookUp(penguinsPath, "public")).toMatchObject({ id: did, access: "view" });
    expect(Object.fromEntries(queries[0])).toMatchObject({ resourceType: "dataset", owner: reader.email });
    expect(resourceLookupQuery(penguinsPath, "public").queryKey.slice(0, 1)).toEqual(publicKey);
    // What the signed-in user may read goes with their session, with the lists of its kind.
    expect(resourceLookupQuery(penguinsPath, "yours").queryKey.slice(0, 3)).toEqual(resourceListKey("dataset"));
  });

  it("finds no private one of the owner's for whoever is not signed in", async () => {
    localStorage.clear();
    addDataset(db, { name: "penguins", ownerUid: reader.uid });

    expect(await lookUp(penguinsPath, "public")).toBeNull();
  });

  it.each([
    ["refuses it", () => HttpResponse.json({ code: 403, message: "Not allowed" }, { status: 403 }), "Not allowed"],
    [
      "fails",
      () => HttpResponse.json({ code: 500, message: "The search is down" }, { status: 500 }),
      "The search is down",
    ],
    ["sends an answer that cannot be read", () => HttpResponse.text("{"), "could not be read"],
  ])("fails with why when the search %s", async (_, response, message) => {
    server.use(http.get("/api/dashboard/search", response));

    await expect(lookUp(penguinsPath)).rejects.toThrow(message);
  });

  it("stops at a page that brings nothing, though the search says there are more after it", async () => {
    let pages = 0;
    // An answer that is never the last, and brings nothing; the fiftieth is, should the lookup read on so far.
    server.use(http.get("/api/dashboard/search", () => HttpResponse.json({ results: [], more: ++pages < 50 })));

    expect(await lookUp(penguinsPath)).toBeNull();
    expect(pages).toBe(1);
  });

  it("stops asking the search when it is called off, as when whoever asked has gone", async () => {
    const asked: Request[] = [];
    server.use(
      http.get("/api/dashboard/search", async ({ request }) => {
        asked.push(request);
        await delay("infinite");
      })
    );
    const client = new QueryClient();
    const lookup = client.fetchQuery(resourceLookupQuery(penguinsPath, "yours")).catch(() => "called off");
    await waitFor(() => expect(asked).toHaveLength(1));

    await client.cancelQueries();

    expect(await lookup).toBe("called off");
    expect(asked[0].signal.aborted).toBe(true);
  });
});

describe("versionListQuery", () => {
  /** The versions as a page reads them. */
  const versionsOf = (...[resource, scope]: Parameters<typeof versionListQuery>) =>
    new QueryClient().fetchQuery(versionListQuery(resource, scope));

  it("lists a dataset's versions newest first, under the key its versions always had", async () => {
    const { did, versions } = addDataset(db, {
      name: "penguins",
      versions: [
        { name: "v1", files: { "penguins.csv": "" } },
        { name: "v2 - by island", files: { "penguins.csv": "" } },
      ],
    });
    const penguins = { kind: "dataset", id: did } as const;

    expect(await versionsOf(penguins)).toEqual([
      { id: versions[1].dvid, name: "v2 - by island", createdAt: versions[1].creationTime },
      { id: versions[0].dvid, name: "v1", createdAt: versions[0].creationTime },
    ]);
    expect(versionListQuery(penguins).queryKey).toEqual([...resourceKey(penguins), "versions"]);
  });

  it("lists a model's versions as a dataset's", async () => {
    const { mid, versions } = addModel(db, { name: "resnet", versions: [{ name: "v1" }, { name: "v2" }] });

    expect(await versionsOf({ kind: "model", id: mid })).toEqual([
      { id: versions[1].mvid, name: "v2", createdAt: versions[1].creationTime },
      { id: versions[0].mvid, name: "v1", createdAt: versions[0].creationTime },
    ]);
  });

  it("lists the versions of a public one for whoever is not signed in, under the public key", async () => {
    localStorage.clear();
    const { did, versions } = addDataset(db, {
      name: "penguins",
      ownerUid: reader.uid,
      isPublic: true,
      versions: [{ name: "v1", files: {} }],
    });
    const penguins = { kind: "dataset", id: did } as const;

    expect(await versionsOf(penguins, "public")).toEqual([
      { id: versions[0].dvid, name: "v1", createdAt: versions[0].creationTime },
    ]);
    expect(versionListQuery(penguins, "public").queryKey.slice(0, 1)).toEqual(publicKey);
  });

  it.each([
    ["one the user may not read", () => addDataset(db, { name: "penguins", ownerUid: reader.uid }).did, "no access"],
    ["one that is not there", () => 404, "Dataset 404 not found"],
  ])("fails with the server's message for %s", async (_, idOf, message) => {
    await expect(versionsOf({ kind: "dataset", id: idOf() })).rejects.toThrow(message);
  });

  it("fails with the server's message for a private one, for whoever is not signed in", async () => {
    localStorage.clear();
    const { mid } = addModel(db, { name: "resnet", ownerUid: reader.uid });

    await expect(versionsOf({ kind: "model", id: mid }, "public")).rejects.toThrow("User has no access to this model");
  });

  it.each([
    ["fails", () => HttpResponse.json({ code: 500, message: "LakeFS is down" }, { status: 500 }), "LakeFS is down"],
    ["sends an answer that cannot be read", () => HttpResponse.text("["), "could not be read"],
  ])("fails with why when the server %s", async (_, response, message) => {
    server.use(http.get("/api/dataset/:did/version/list", response));

    await expect(versionsOf({ kind: "dataset", id: addDataset(db, { name: "penguins" }).did })).rejects.toThrow(
      message
    );
  });
});
