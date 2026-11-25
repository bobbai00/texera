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

// The search of the Dashboard Service (DashboardResource.scala), which finds workflows, datasets and models for
// the lists of every kind, and those of an owner, as a dataset or a model is looked up by its path. The real search
// matches keywords with PGroonga, which also accepts near misses; this one finds a keyword only where the name or the
// description contains it.

import { http, HttpResponse } from "msw/http";
import { errorResponse, type MockResource, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import { dashboardDataset } from "./dataset";
import type { MockDb } from "./index";
import { dashboardModel } from "./model";
import { dashboardWorkflow } from "./workflow";

/** What the search orders and filters by, whatever the kind (UnifiedResourceSchema.scala). */
interface Found {
  name: string;
  description: string | null;
  creationTime: number;
  /** Only workflows have one. */
  lastModifiedTime: number | null;
  /** The email of its owner, which the owner filter matches. */
  ownerEmail: string;
  entry: object;
}

/** A resource as the search finds it for a user: its entry of the answer, and what the search reads of it. */
export function foundOf(db: MockDb, resource: MockResource, uid: number): Found {
  const privilege = privilegeOf(resource, uid);
  const ownerEmail = db.users.find(user => user.uid === resource.ownerUid)!.email;
  if (resource.type === "workflow") {
    const workflow = db.workflows.find(candidate => candidate.wid === resource.id)!;
    return {
      ...workflow,
      ownerEmail,
      entry: { resourceType: "workflow", workflow: dashboardWorkflow(db, workflow, uid, privilege) },
    };
  }
  if (resource.type === "dataset") {
    const dataset = db.datasets.find(candidate => candidate.did === resource.id)!;
    const entry = { resourceType: "dataset", dataset: dashboardDataset(db, dataset, uid, privilege) };
    return { ...dataset, lastModifiedTime: null, ownerEmail, entry };
  }
  const model = db.models.find(candidate => candidate.mid === resource.id)!;
  return {
    ...model,
    lastModifiedTime: null,
    ownerEmail,
    entry: { resourceType: "model", model: dashboardModel(db, model, uid, privilege) },
  };
}

/**
 * The search's answer from what it found: those of the owners it names, if it names any, by their emails, with every
 * keyword of the query, in the order it asks for, a page of them from start.
 */
export function searchAnswer(found: Found[], query: URLSearchParams) {
  const owners = query.getAll("owner");
  // The server cuts the keywords at the characters that PGroonga reads as operators.
  const keywords = query
    .getAll("query")
    .flatMap(keyword => keyword.split(/[+\-()<>~*@"\s]/))
    .filter(Boolean)
    .map(keyword => keyword.toLowerCase());
  const [, column = "EditTime", direction = "Desc"] =
    /^(Name|CreateTime|EditTime|ExecutionTime)(Asc|Desc)$/.exec(query.get("orderBy") ?? "") ?? [];
  const start = Number(query.get("start") ?? 0);
  const count = Number(query.get("count") ?? 20);

  const matches = found
    .filter(({ ownerEmail }) => owners.length === 0 || owners.includes(ownerEmail))
    .filter(({ name, description }) => {
      const text = `${name} ${description ?? ""}`.toLowerCase();
      return keywords.every(keyword => text.includes(keyword));
    })
    .sort((a, b) => {
      const order = direction === "Asc" ? 1 : -1;
      if (column === "Name") return order * a.name.localeCompare(b.name);
      if (column === "CreateTime") return order * (a.creationTime - b.creationTime);
      // Only workflows have a time of their last edit; what has none comes last. Nothing here has run.
      if (column === "EditTime") return order * ((a.lastModifiedTime ?? -Infinity) - (b.lastModifiedTime ?? -Infinity));
      return 0;
    });
  return HttpResponse.json({
    results: matches.slice(start, start + count).map(({ entry }) => entry),
    more: matches.length > start + count,
    hasMismatch: false,
  });
}

export function searchHandlers(db: MockDb) {
  return [
    // GET /dashboard/search?resourceType=&query=&orderBy=&start=&count=&owner=…&includePublic= -> {results, more,
    // hasMismatch}
    http.get("/api/dashboard/search", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const query = new URL(request.url).searchParams;
      const resourceType = query.get("resourceType") ?? "";
      const types = resourceType === "" ? ["workflow", "dataset", "model"] : [resourceType];
      if (!types.every(type => ["workflow", "dataset", "model"].includes(type))) {
        return errorResponse(400, `Unknown resource type: ${resourceType}`);
      }
      // What the user owns or was granted, and with includePublic every public one too
      // (VersionedResourceSearchQueryBuilder.constructFromClause).
      const includePublic = query.get("includePublic") === "true";
      const visible = db.resources.filter(
        resource =>
          types.includes(resource.type) &&
          (privilegeOf(resource, user.uid) !== "NONE" || (includePublic && resource.isPublic))
      );
      return searchAnswer(
        visible.map(resource => foundOf(db, resource, user.uid)),
        query
      );
    }),
  ];
}
