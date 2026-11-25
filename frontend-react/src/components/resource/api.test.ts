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
import { http } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { addModel } from "@/testing/mock-api/model";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { resourceKey, resourceListKey, resourceListQuery, sharedWithQuery } from "./api";

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
