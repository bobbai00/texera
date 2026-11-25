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

// The hub (HubResource.scala, DashboardResource.publicSearch), making resources public (WorkflowResource.scala,
// DatasetResource.scala, ModelResource.scala), and copying a public workflow (WorkflowResource.cloneWorkflow).

import { http, HttpResponse } from "msw/http";
import { errorResponse, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";
import { foundOf, searchAnswer } from "./search";
import { addWorkflow } from "./workflow";

/** A like of a resource, by the person who likes it. */
export interface MockLike {
  type: "workflow" | "dataset" | "model";
  id: number;
  uid: number;
}

type HubType = MockLike["type"];

export function hubHandlers(db: MockDb) {
  const resourceOf = (type: string, id: number) =>
    db.resources.find(resource => resource.type === type && resource.id === id);
  /** Who is signed in, if anyone: the hub answers people who are not, too. */
  const maybeSignedIn = (request: Request) => {
    const user = signedInUser(db, request);
    return user instanceof Response ? undefined : user;
  };
  const toggled = (type: HubType) =>
    http.post<{ id: string }>(`/api/${type}/:id/update/publicity`, ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const resource = resourceOf(type, Number(params.id));
      if (!resource || privilegeOf(resource, user.uid) !== "WRITE") return errorResponse(403, "No access.");
      resource.isPublic = !resource.isPublic;
      return new HttpResponse(null, { status: 200 });
    });

  return [
    // GET /dashboard/publicSearch?resourceType=&query=&orderBy=&start=&count=&owner=… -> everyone's public resources
    // of the type, searched as the user's own are. It searches as no one, whoever asks: the public ones alone, whatever
    // includePublic says.
    http.get("/api/dashboard/publicSearch", ({ request }) => {
      const query = new URL(request.url).searchParams;
      const type = query.get("resourceType") ?? "workflow";
      const uid = maybeSignedIn(request)?.uid ?? 0;
      const publicOnes = db.resources.filter(resource => resource.type === type && resource.isPublic);
      return searchAnswer(
        publicOnes.map(resource => foundOf(db, resource, uid)),
        query
      );
    }),

    // GET /hub/counts?entityType=&entityId=…&actionTypes=… -> how many like and copied each.
    http.get("/api/hub/counts", ({ request }) => {
      const query = new URL(request.url).searchParams;
      const type = query.get("entityType") as HubType;
      return HttpResponse.json(
        query.getAll("entityId").map(id => ({
          entityId: Number(id),
          entityType: type,
          counts: {
            like: db.likes.filter(like => like.type === type && like.id === Number(id)).length,
            clone: db.clones.filter(wid => type === "workflow" && wid === Number(id)).length,
          },
        }))
      );
    }),

    // GET /hub/isLiked?entityId=&entityType= -> whether the signed-in user likes it.
    http.get("/api/hub/isLiked", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const query = new URL(request.url).searchParams;
      const [type, id] = [query.get("entityType") as HubType, Number(query.get("entityId"))];
      const isLiked = db.likes.some(like => like.type === type && like.id === id && like.uid === user.uid);
      return HttpResponse.json([{ entityId: id, entityType: type, isLiked }]);
    }),

    // POST /hub/like and /hub/unlike {entityId, entityType} -> whether it changed anything.
    http.post("/api/hub/:action", async ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { entityId, entityType } = (await request.json()) as { entityId: number; entityType: HubType };
      const mine = (like: MockLike) => like.type === entityType && like.id === entityId && like.uid === user.uid;
      const liked = db.likes.some(mine);
      if (params.action === "like" && !liked) db.likes.push({ type: entityType, id: entityId, uid: user.uid });
      if (params.action === "unlike") db.likes = db.likes.filter(like => !mine(like));
      return HttpResponse.json(params.action === "like" ? !liked : liked);
    }),

    // GET /workflow/publicised/{wid} -> the public workflow, to anyone. One that is not public is not found.
    http.get<{ wid: string }>("/api/workflow/publicised/:wid", ({ params }) => {
      const workflow = db.workflows.find(each => each.wid === Number(params.wid));
      if (!workflow || !resourceOf("workflow", workflow.wid)?.isPublic) {
        return errorResponse(404, `Public workflow with id ${params.wid} not found`);
      }
      const { wid, name, description, content } = workflow;
      return HttpResponse.json({ wid, name, description, content, readonly: true });
    }),

    // POST /workflow/clone/{wid} -> the id of a new workflow of the user's, with the public workflow's content.
    http.post<{ wid: string }>("/api/workflow/clone/:wid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const original = db.workflows.find(each => each.wid === Number(params.wid));
      const resource = original && resourceOf("workflow", original.wid);
      if (!original || !resource || (!resource.isPublic && privilegeOf(resource, user.uid) === "NONE")) {
        return errorResponse(403, "No sufficient access privilege.");
      }
      db.clones.push(original.wid);
      const copy = addWorkflow(db, {
        name: `${original.name}_copy`,
        content: JSON.parse(original.content) as Parameters<typeof addWorkflow>[1]["content"],
        ownerUid: user.uid,
      });
      return HttpResponse.json(copy.wid);
    }),

    // PUT /workflow/public/{wid} and /workflow/private/{wid}, by someone who may change the workflow.
    http.put<{ visibility: string; wid: string }>("/api/workflow/:visibility/:wid", ({ request, params }) => {
      if (params.visibility !== "public" && params.visibility !== "private") return undefined;
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const resource = resourceOf("workflow", Number(params.wid));
      if (!resource || privilegeOf(resource, user.uid) !== "WRITE") return errorResponse(403, "No access.");
      resource.isPublic = params.visibility === "public";
      return new HttpResponse(null, { status: 204 });
    }),

    // POST /dataset/{did}/update/publicity and /model/{mid}/update/publicity turn its publicity over.
    toggled("dataset"),
    toggled("model"),
  ];
}
