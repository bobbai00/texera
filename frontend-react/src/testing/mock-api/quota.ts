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

// What a user has made and what their executions keep (UserQuotaResource.scala), from the records the other
// handlers keep, and the user's Python environments (PveResource.scala, /pve/db).

import { http, HttpResponse } from "msw/http";
import { errorResponse, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** A Python environment: a name and its packages, each "==1.2" or ">=1.0". */
export interface MockEnvironment {
  veid: number;
  uid: number;
  name: string;
  packages: Record<string, string>;
}

export function quotaHandlers(db: MockDb) {
  const owned = (uid: number, type: "workflow" | "dataset") =>
    db.resources.filter(resource => resource.type === type && resource.ownerUid === uid);

  return [
    http.get("/api/quota/created_workflows", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        owned(user.uid, "workflow").map(({ id }) => {
          const workflow = db.workflows.find(each => each.wid === id)!;
          return { userId: user.uid, workflowId: id, workflowName: workflow.name, creationTime: workflow.creationTime };
        })
      );
    }),

    http.get("/api/quota/access_workflows", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.resources
          .filter(resource => resource.type === "workflow" && privilegeOf(resource, user.uid) !== "NONE")
          .map(resource => resource.id)
      );
    }),

    // Every dataset's size is 0, as the backend's own statistics have it.
    http.get("/api/quota/created_datasets", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        owned(user.uid, "dataset").map(({ id }) => {
          const dataset = db.datasets.find(each => each.did === id)!;
          return { did: id, name: dataset.name, creationTime: dataset.creationTime, size: 0 };
        })
      );
    }),

    http.get("/api/quota/user_quota_size", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.executionRecords
          .filter(record => record.uid === user.uid)
          .map(record => ({
            eid: record.eid,
            workflowId: record.wid,
            workflowName: db.workflows.find(each => each.wid === record.wid)?.name ?? "",
            ...record.kept,
          }))
      );
    }),

    http.delete<{ eid: string }>("/api/quota/deleteCollection/:eid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const record = db.executionRecords.find(each => each.eid === Number(params.eid));
      if (!record || record.uid !== user.uid) return errorResponse(403, "No sufficient access privilege.");
      record.kept = { resultBytes: 0, runTimeStatsBytes: 0, logBytes: 0 };
      return new HttpResponse(null, { status: 200 });
    }),

    http.get("/api/pve/db", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.environments
          .filter(environment => environment.uid === user.uid)
          .map(({ veid, name, packages }) => ({ veid, name, packages }))
      );
    }),

    http.post("/api/pve/db", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { name, packages } = (await request.json()) as Omit<MockEnvironment, "veid" | "uid">;
      if (db.environments.some(each => each.uid === user.uid && each.name === name)) {
        return errorResponse(409, `An environment named ${name} exists already.`);
      }
      const veid = Math.max(0, ...db.environments.map(each => each.veid)) + 1;
      db.environments.push({ veid, uid: user.uid, name, packages });
      return HttpResponse.json({ veid }, { status: 201 });
    }),

    http.put<{ veid: string }>("/api/pve/db/:veid", async ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const environment = db.environments.find(each => each.veid === Number(params.veid) && each.uid === user.uid);
      if (!environment) return errorResponse(404, "No such environment.");
      Object.assign(environment, (await request.json()) as Omit<MockEnvironment, "veid" | "uid">);
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete<{ veid: string }>("/api/pve/db/:veid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const before = db.environments.length;
      db.environments = db.environments.filter(each => !(each.veid === Number(params.veid) && each.uid === user.uid));
      return before === db.environments.length
        ? errorResponse(404, "No such environment.")
        : new HttpResponse(null, { status: 204 });
    }),
  ];
}
