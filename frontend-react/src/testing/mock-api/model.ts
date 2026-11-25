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

// The model endpoints of the File Service that the app calls (ModelResource.scala), with the fields the app
// reads, in the server's shapes. A model is stored and shared like a dataset.

import { http, HttpResponse } from "msw/http";
import { admin } from "../fixtures";
import { errorResponse, type MockPrivilege, type MockResource, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** A model. Its owner, its visibility, and who it is shared with are in db.resources. */
export interface MockModel {
  mid: number;
  name: string;
  description: string;
  /** In epoch milliseconds. */
  creationTime: number;
  /** What it was made with, such as "PyTorch", and how it is saved, as its owner said, if they did. */
  framework?: string;
  format?: string;
  /** In the order they were made. */
  versions: MockModelVersion[];
}

export interface MockModelVersion {
  mvid: number;
  name: string;
  creationTime: number;
}

/** A model as a test describes it. Only the name is needed; the owner is the admin. */
export interface ModelSeed {
  name: string;
  description?: string;
  ownerUid?: number;
  isPublic?: boolean;
  grants?: MockResource["grants"];
  creationTime?: number;
  framework?: string;
  format?: string;
  /** Oldest first. Each is made a day after the one before it. */
  versions?: { name: string }[];
}

const noAccess = "User has no access to this model";
const day = 24 * 60 * 60 * 1000;

/** Adds a model, as if its owner had made it and its versions, and returns it. */
export function addModel(db: MockDb, seed: ModelSeed): MockModel {
  const { name, description = "", ownerUid = admin.uid, isPublic = false, grants = [], versions = [] } = seed;
  const creationTime = seed.creationTime ?? Date.UTC(2026, 10, 12, 12);
  // Version ids are unique across models, like the server's serial mvid.
  const firstMvid = Math.max(0, ...db.models.flatMap(model => model.versions.map(version => version.mvid))) + 1;
  const model: MockModel = {
    mid: Math.max(0, ...db.models.map(other => other.mid)) + 1,
    name,
    description,
    creationTime,
    ...(seed.framework !== undefined && { framework: seed.framework }),
    ...(seed.format !== undefined && { format: seed.format }),
    versions: versions.map((version, index) => ({
      mvid: firstMvid + index,
      name: version.name,
      creationTime: creationTime + (index + 1) * day,
    })),
  };
  db.models.push(model);
  db.resources.push({ type: "model", id: model.mid, ownerUid, isPublic, grants });
  return model;
}

/** A model as the server sends it (DashboardModel) to a user with this privilege on it. */
export function dashboardModel(db: MockDb, model: MockModel, uid: number, accessPrivilege: MockPrivilege | "NONE") {
  const { mid, name, description, creationTime, framework = null, format = null } = model;
  const { ownerUid, isPublic } = db.resources.find(resource => resource.type === "model" && resource.id === mid)!;
  return {
    model: { mid, name, description, isPublic, creationTime, framework, format },
    ownerEmail: db.users.find(user => user.uid === ownerUid)!.email,
    accessPrivilege,
    isOwner: ownerUid === uid,
  };
}

export function modelHandlers(db: MockDb) {
  const resourceOf = (mid: number) =>
    db.resources.find(candidate => candidate.type === "model" && candidate.id === mid);

  return [
    // DELETE /model/{mid}: only its owner may delete a model.
    http.delete<{ mid: string }>("/api/model/:mid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const mid = Number(params.mid);
      const resource = resourceOf(mid);
      if (!resource) return errorResponse(404, `Model ${mid} not found`);
      if (resource.ownerUid !== user.uid) return errorResponse(403, noAccess);
      db.models = db.models.filter(model => model.mid !== mid);
      db.resources = db.resources.filter(other => other !== resource);
      return new HttpResponse();
    }),

    // GET /model/{mid}/version/list: newest first, to whoever may read the model, as its owner, as one it is shared
    // with, or because it is public.
    http.get<{ mid: string }>("/api/model/:mid/version/list", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const model = db.models.find(candidate => candidate.mid === Number(params.mid));
      if (!model) return errorResponse(404, `Model ${params.mid} not found`);
      const resource = resourceOf(model.mid)!;
      if (!resource.isPublic && privilegeOf(resource, user.uid) === "NONE") return errorResponse(403, noAccess);
      return HttpResponse.json(model.versions.toReversed().map(modelVersion));
    }),

    // GET /model/{mid}/publicVersion/list: the versions of a public model, to anyone, signed in or not.
    http.get<{ mid: string }>("/api/model/:mid/publicVersion/list", ({ params }) => {
      const model = db.models.find(candidate => candidate.mid === Number(params.mid));
      if (!model) return errorResponse(404, `Model ${params.mid} not found`);
      if (!resourceOf(model.mid)!.isPublic) return errorResponse(403, noAccess);
      return HttpResponse.json(model.versions.toReversed().map(modelVersion));
    }),
  ];
}

/** A version as the server sends it (ModelVersion), with the fields the app reads. */
function modelVersion({ mvid, name, creationTime }: MockModelVersion) {
  return { mvid, name, creationTime };
}
