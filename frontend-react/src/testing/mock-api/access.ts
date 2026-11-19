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

import { http, HttpResponse } from "msw/http";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

const ownerChangeRefused = "You cannot modify the owner's permissions!";
const internalError = "There was an error processing your request. It has been logged (ID 5d2c8e1f0a9b3c47).";

/** What a person may do with a resource they are given: view it, or also change it (PrivilegeEnum). */
export type MockPrivilege = "READ" | "WRITE";

/** A resource of any type as the access rules see it: who owns it, whether it is public, and who it is shared with. */
export interface MockResource {
  /** As the access endpoints name it, such as "dataset". */
  type: string;
  id: number;
  ownerUid: number;
  /** Anyone signed in may view a public resource. */
  isPublic: boolean;
  /** The people it is shared with and what each may do, like the rows of dataset_user_access. Never the owner. */
  grants: { uid: number; privilege: MockPrivilege }[];
}

/** What a user may do with a resource (ResourceAccess.privilegeOf): its owner may always change it. */
export function privilegeOf(resource: MockResource, uid: number): MockPrivilege | "NONE" {
  if (resource.ownerUid === uid) return "WRITE";
  return resource.grants.find(grant => grant.uid === uid)?.privilege ?? "NONE";
}

/** The access endpoints of every type of resource, answered as ResourceAccess.scala does for datasets and models. */
export function accessHandlers(db: MockDb) {
  /**
   * The resource, when the signed-in user may view it (or change it, when the call needs "WRITE");
   * otherwise the answer the server gives instead.
   */
  function authorized(request: Request, { type, id }: { type: string; id: string }, needs: MockPrivilege) {
    const user = signedInUser(db, request);
    if (user instanceof Response) return user;
    const resource = db.resources.find(candidate => candidate.type === type && candidate.id === Number(id));
    // requireWriteAccess, then requireReadAccess. A resource that does not exist is one the user may not see.
    if (needs === "WRITE" && (!resource || privilegeOf(resource, user.uid) !== "WRITE")) {
      return errorResponse(403, `You do not have permission to modify ${type} ${id}`);
    }
    if (!resource || (!resource.isPublic && privilegeOf(resource, user.uid) === "NONE")) {
      return errorResponse(403, `You do not have access to ${type} ${id}`);
    }
    return resource;
  }

  return [
    // GET /access/{type}/owner/{id} -> the owner's email, as bare text that the server labels JSON.
    http.get<{ type: string; id: string }>("/api/access/:type/owner/:id", ({ request, params }) => {
      const resource = authorized(request, params, "READ");
      if (resource instanceof Response) return resource;
      const owner = db.users.find(user => user.uid === resource.ownerUid);
      return new HttpResponse(owner?.email, { headers: { "Content-Type": "application/json" } });
    }),

    // GET /access/{type}/list/{id} -> [{email, name, privilege}] of everyone but the owner.
    http.get<{ type: string; id: string }>("/api/access/:type/list/:id", ({ request, params }) => {
      const resource = authorized(request, params, "READ");
      if (resource instanceof Response) return resource;
      return HttpResponse.json(
        resource.grants.flatMap(({ uid, privilege }) => {
          const user = db.users.find(candidate => candidate.uid === uid);
          return user ? [{ email: user.email, name: user.name, privilege }] : [];
        })
      );
    }),

    // PUT /access/{type}/grant/{id}/{email}/{privilege}: shares the resource, or replaces what the person may do.
    http.put<{ type: string; id: string; email: string; privilege: string }>(
      "/api/access/:type/grant/:id/:email/:privilege",
      ({ request, params }) => {
        const resource = authorized(request, params, "WRITE");
        if (resource instanceof Response) return resource;
        const grantee = db.users.find(user => user.email === params.email);
        if (!grantee) return errorResponse(400, `No registered user with email ${params.email}`);
        if (grantee.uid === resource.ownerUid) return errorResponse(403, ownerChangeRefused);
        // The server fails on a privilege it does not know. It knows NONE too, but this app never sends it.
        const { privilege } = params;
        if (privilege !== "READ" && privilege !== "WRITE") return errorResponse(500, internalError);
        resource.grants = [
          ...resource.grants.filter(grant => grant.uid !== grantee.uid),
          { uid: grantee.uid, privilege },
        ];
        return new HttpResponse();
      }
    ),

    // DELETE /access/{type}/revoke/{id}/{email}: stops sharing the resource with the person.
    http.delete<{ type: string; id: string; email: string }>(
      "/api/access/:type/revoke/:id/:email",
      ({ request, params }) => {
        const resource = authorized(request, params, "WRITE");
        if (resource instanceof Response) return resource;
        const grantee = db.users.find(user => user.email === params.email);
        // The server reads the uid of the user it did not find (ResourceAccess.scala:294).
        if (!grantee) return errorResponse(500, internalError);
        if (grantee.uid === resource.ownerUid) return errorResponse(403, ownerChangeRefused);
        resource.grants = resource.grants.filter(grant => grant.uid !== grantee.uid);
        return new HttpResponse();
      }
    ),
  ];
}

/** An error as Dropwizard writes it. */
export function errorResponse(status: number, message: string) {
  return HttpResponse.json({ code: status, message }, { status });
}
