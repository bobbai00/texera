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

// The administration endpoints (AdminUserResource.scala, AdminExecutionResource.scala, and the computing-unit
// service's /admin), for administrators only.

import { http, HttpResponse } from "msw/http";
import type { TestUser } from "../fixtures";
import { errorResponse } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** The engine's status codes as the administration list names them (AdminExecutionResource.scala). */
const statusNames: Record<number, string> = {
  0: "READY",
  1: "RUNNING",
  2: "PAUSED",
  3: "COMPLETED",
  4: "FAILED",
  5: "KILLED",
};

/** When the fake backend says every account was made, in seconds as the server sends it. */
const accountCreation = Date.UTC(2026, 10, 1, 9) / 1000;

export function adminHandlers(db: MockDb) {
  const administrator = (request: Request): TestUser | Response => {
    const user = signedInUser(db, request);
    if (user instanceof Response) return user;
    return user.role === "ADMIN" ? user : errorResponse(403, "User not authorized.");
  };

  return [
    // GET /admin/user/list -> every account (UserInfo), its times in seconds.
    http.get("/api/admin/user/list", ({ request }) => {
      const user = administrator(request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.users.map(({ uid, name, email, role, comment, affiliation, joiningReason }) => ({
          uid,
          name,
          email,
          googleId: null,
          role,
          avatar: null,
          comment: comment ?? null,
          lastLogin: role === "INACTIVE" ? null : accountCreation + 3600,
          accountCreation,
          affiliation: affiliation ?? null,
          joiningReason: joiningReason ?? null,
          isPlaceholder: false,
        }))
      );
    }),

    // GET /admin/execution/executionList/{pageSize}/{pageIndex}/{sortField}/{sortDirection}?filter=…: the latest
    // execution of each workflow, of the statuses named by each filter, the most recently ended first.
    http.get<{ pageSize: string; pageIndex: string }>(
      "/api/admin/execution/executionList/:pageSize/:pageIndex/:sortField/:sortDirection",
      ({ request, params }) => {
        const user = administrator(request);
        if (user instanceof Response) return user;
        const only = new URL(request.url).searchParams.getAll("filter");
        const latest = new Map(db.executionRecords.map(record => [record.wid, record]));
        const size = Number(params.pageSize);
        return HttpResponse.json(
          [...latest.values()]
            .filter(record => only.length === 0 || only.includes(statusNames[record.status]))
            .toSorted((a, b) => (b.lastUpdateTime ?? b.startingTime) - (a.lastUpdateTime ?? a.startingTime))
            .slice(Number(params.pageIndex) * size, (Number(params.pageIndex) + 1) * size)
            .map(record => ({
              workflowName: db.workflows.find(each => each.wid === record.wid)?.name ?? "",
              workflowId: record.wid,
              userName: db.users.find(each => each.uid === record.uid)?.name ?? "",
              userId: record.uid,
              executionId: record.eid,
              executionStatus: statusNames[record.status],
              executionTime: ((record.lastUpdateTime ?? record.startingTime) - record.startingTime) / 1000,
              executionName: record.name,
              startTime: record.startingTime,
              endTime: record.lastUpdateTime,
              access: true,
            }))
        );
      }
    ),

    // GET /computing-unit/admin/list -> every unit, whoever owns it.
    http.get("/api/computing-unit/admin/list", ({ request }) => {
      const user = administrator(request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.computingUnits.map(({ cuid, name, creationTime, status, type, resource: limits }) => {
          const ownerUid = db.resources.find(each => each.type === "computing-unit" && each.id === cuid)?.ownerUid;
          return {
            computingUnit: { cuid, uid: ownerUid, name, creationTime, type, uri: "", resource: JSON.stringify(limits) },
            status,
            statusReason: null,
            isOwner: ownerUid === user.uid,
            accessPrivilege: "WRITE",
            ownerAvatar: "",
            ownerName: db.users.find(each => each.uid === ownerUid)?.name ?? "",
          };
        })
      );
    }),

    // PUT /admin/user/update {uid, name, email, role, comment}.
    http.put("/api/admin/user/update", async ({ request }) => {
      const user = administrator(request);
      if (user instanceof Response) return user;
      const changed = (await request.json()) as Pick<TestUser, "uid" | "name" | "email" | "role" | "comment">;
      const member = db.users.find(each => each.uid === changed.uid);
      if (!member) return errorResponse(404, "No such user.");
      Object.assign(member, changed);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
