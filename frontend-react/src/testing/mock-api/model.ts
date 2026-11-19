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
import { errorResponse, type MockPrivilege, type MockResource } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** A model. Its owner, its visibility, and who it is shared with are in db.resources. */
export interface MockModel {
  mid: number;
  name: string;
  description: string;
  /** In epoch milliseconds. */
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
}

/** Adds a model, as if its owner had made it, and returns it. */
export function addModel(db: MockDb, seed: ModelSeed): MockModel {
  const { name, description = "", ownerUid = admin.uid, isPublic = false, grants = [] } = seed;
  const model: MockModel = {
    mid: Math.max(0, ...db.models.map(other => other.mid)) + 1,
    name,
    description,
    creationTime: seed.creationTime ?? Date.UTC(2026, 10, 12, 12),
  };
  db.models.push(model);
  db.resources.push({ type: "model", id: model.mid, ownerUid, isPublic, grants });
  return model;
}

/** A model as the server sends it (DashboardModel) to a user with this privilege on it. */
export function dashboardModel(db: MockDb, model: MockModel, uid: number, accessPrivilege: MockPrivilege | "NONE") {
  const { mid, name, description, creationTime } = model;
  const { ownerUid, isPublic } = db.resources.find(resource => resource.type === "model" && resource.id === mid)!;
  return {
    model: { mid, name, description, isPublic, creationTime },
    ownerEmail: db.users.find(user => user.uid === ownerUid)!.email,
    accessPrivilege,
    isOwner: ownerUid === uid,
  };
}

export function modelHandlers(db: MockDb) {
  return [
    // DELETE /model/{mid}: only its owner may delete a model.
    http.delete<{ mid: string }>("/api/model/:mid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const mid = Number(params.mid);
      const resource = db.resources.find(candidate => candidate.type === "model" && candidate.id === mid);
      if (!resource) return errorResponse(404, `Model ${mid} not found`);
      if (resource.ownerUid !== user.uid) return errorResponse(403, "User has no access to this model");
      db.models = db.models.filter(model => model.mid !== mid);
      db.resources = db.resources.filter(other => other !== resource);
      return new HttpResponse();
    }),
  ];
}
