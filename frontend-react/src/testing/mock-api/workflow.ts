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

// The workflow endpoints of the Dashboard Service that the app calls (WorkflowResource.scala,
// SystemMetadataResource.scala) and the compiling service (WorkflowCompilationResource.scala), with the fields
// the app reads, in the servers' shapes.

import { compare } from "fast-json-patch";
import { http, HttpResponse } from "msw/http";
import type { LogicalPlan } from "@/lib/workflow/plan";
import { emptyContent, type WorkflowContent } from "@/lib/workflow/model";
import type { VersionRecord } from "@/lib/workflow/versions";
import { admin } from "../fixtures";
import { operatorMetadata } from "../workflow";
import { errorResponse, type MockPrivilege, type MockResource, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import { evaluate } from "./engine";
import type { MockDb } from "./index";

/** A workflow. Its owner, and who it is shared with, are in db.resources. */
export interface MockWorkflow {
  wid: number;
  name: string;
  description: string | null;
  /** Everything on its canvas, as JSON in a string. */
  content: string;
  /** In epoch milliseconds. */
  creationTime: number;
  lastModifiedTime: number;
  /** What each save that changed the content saved, and when, oldest first: the workflow's versions. */
  saves: [time: number, content: WorkflowContent][];
}

/** A workflow as a test describes it. Only the name is needed; the owner is the admin, and the canvas is empty. */
export interface WorkflowSeed {
  name: string;
  description?: string | null;
  content?: WorkflowContent;
  ownerUid?: number;
  grants?: MockResource["grants"];
  creationTime?: number;
  /** What each save saved, and when, oldest first. The last is the workflow's content, in place of `content`. */
  saves?: [time: number, content: WorkflowContent][];
}

/** Adds a workflow, as if its owner had made it, and returns it. */
export function addWorkflow(db: MockDb, seed: WorkflowSeed): MockWorkflow {
  const { name, description = null, content = emptyContent, ownerUid = admin.uid, grants = [] } = seed;
  const creationTime = seed.creationTime ?? Date.UTC(2026, 10, 12, 12);
  const saves = seed.saves ?? [[creationTime, content]];
  const workflow: MockWorkflow = {
    wid: Math.max(0, ...db.workflows.map(other => other.wid)) + 1,
    name,
    description,
    content: JSON.stringify(saves.at(-1)![1]),
    creationTime,
    lastModifiedTime: creationTime,
    saves,
  };
  db.workflows.push(workflow);
  db.resources.push({ type: "workflow", id: workflow.wid, ownerUid, isPublic: false, grants });
  return workflow;
}

/**
 * A workflow as the search sends it (DashboardWorkflow, built by WorkflowSearchQueryBuilder.toEntry). The search
 * selects only some columns of the workflow, so isPublic and content come back null.
 */
export function dashboardWorkflow(
  db: MockDb,
  workflow: MockWorkflow,
  uid: number,
  accessLevel: MockPrivilege | "NONE"
) {
  const { ownerUid } = db.resources.find(resource => resource.type === "workflow" && resource.id === workflow.wid)!;
  const { wid, name, description, creationTime, lastModifiedTime } = workflow;
  return {
    isOwner: ownerUid === uid,
    accessLevel,
    ownerName: db.users.find(user => user.uid === ownerUid)!.name,
    workflow: { wid, name, description, creationTime, lastModifiedTime, isPublic: null, content: null },
    ownerId: ownerUid,
    coverImage: null,
    hasUnpublishedChanges: false,
  };
}

/**
 * The versions a backend keeps of these saves, newest first: for each save, the patch that turns what it saved back
 * into what the save before it saved (WorkflowVersionResource.insertVersion), and for the first, back into nothing.
 */
export function recordsOf(saves: [time: number, content: WorkflowContent][]): VersionRecord[] {
  return saves
    .map(([time, content], index) => ({
      vId: index + 1,
      creationTime: time,
      content: JSON.stringify(compare(content, index === 0 ? {} : saves[index - 1][1])),
    }))
    .reverse();
}

export function workflowHandlers(db: MockDb) {
  const resourceOf = (wid: number) =>
    db.resources.find(resource => resource.type === "workflow" && resource.id === wid);

  return [
    // GET /resources/operator-metadata -> {operators, groups}: every operator type, the same for everyone.
    http.get("/api/resources/operator-metadata", () => HttpResponse.json(operatorMetadata)),

    // GET /workflow/{wid} -> WorkflowWithPrivilege. Whoever may not change the workflow gets it read-only.
    http.get<{ wid: string }>("/api/workflow/:wid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const workflow = db.workflows.find(candidate => candidate.wid === Number(params.wid));
      const privilege = workflow ? privilegeOf(resourceOf(workflow.wid)!, user.uid) : "NONE";
      if (!workflow || privilege === "NONE") return errorResponse(403, "No sufficient access privilege.");
      const { wid, name, description, content, creationTime, lastModifiedTime } = workflow;
      return HttpResponse.json({
        wid,
        name,
        description,
        content,
        creationTime,
        lastModifiedTime,
        isPublished: resourceOf(workflow.wid)?.isPublic ?? false,
        readonly: privilege !== "WRITE",
        defaultView: "CANVAS",
      });
    }),

    // GET /version/{wid} -> [VersionEntry]: the workflow's versions, newest first, to whoever may see it. Anyone
    // else gets none (WorkflowVersionResource.retrieveVersionsOfWorkflow).
    http.get<{ wid: string }>("/api/version/:wid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const workflow = db.workflows.find(candidate => candidate.wid === Number(params.wid));
      if (!workflow || privilegeOf(resourceOf(workflow.wid)!, user.uid) === "NONE") return HttpResponse.json([]);
      return HttpResponse.json(recordsOf(workflow.saves).map(record => ({ ...record, importance: true })));
    }),

    // POST /workflow/persist {wid, name, description, content}: saves the three fields, and makes a version when
    // the content differs. It answers with the saved row.
    http.post("/api/workflow/persist", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const saved = (await request.json()) as Pick<MockWorkflow, "wid" | "name" | "description" | "content">;
      const workflow = db.workflows.find(candidate => candidate.wid === saved.wid);
      if (!workflow || privilegeOf(resourceOf(workflow.wid)!, user.uid) !== "WRITE") {
        return errorResponse(403, "No sufficient access privilege.");
      }
      if (workflow.content !== saved.content)
        workflow.saves.push([Date.now(), JSON.parse(saved.content) as WorkflowContent]);
      Object.assign(workflow, { name: saved.name, description: saved.description, content: saved.content });
      return HttpResponse.json(workflow);
    }),

    // POST /workflow/create {name, content} -> DashboardWorkflow of a new workflow that the user owns.
    http.post("/api/workflow/create", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { name, content } = (await request.json()) as { name: string; content: string };
      const workflow = addWorkflow(db, {
        name,
        content: JSON.parse(content) as WorkflowContent,
        ownerUid: user.uid,
        creationTime: Date.now(),
      });
      return HttpResponse.json({ ...dashboardWorkflow(db, workflow, user.uid, "WRITE"), workflow });
    }),

    // POST /workflow/delete {wids}: deletes the workflows, all or none. A workflow that the user does not own stops
    // it, but the server swallows that refusal and answers as if it had deleted them (WorkflowResource.scala:625).
    http.post("/api/workflow/delete", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const { wids } = (await request.json()) as { wids: number[] };
      if (wids.every(wid => resourceOf(wid)?.ownerUid === user.uid)) {
        db.workflows = db.workflows.filter(workflow => !wids.includes(workflow.wid));
        db.resources = db.resources.filter(resource => resource.type !== "workflow" || !wids.includes(resource.id));
      }
      return new HttpResponse(null, { status: 204 });
    }),

    // POST /compile {operators, links, ...} -> the columns each operator puts out, by port, and the operators
    // that do not compile. A port whose columns are not known is null.
    http.post("/api/compile", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const plan = (await request.json()) as LogicalPlan;
      const { outputs, errors } = evaluate(plan, db.files);
      const operatorErrors = Object.fromEntries(
        Object.entries(errors).map(([operatorId, message]) => [
          operatorId,
          { type: { name: "COMPILATION_ERROR" }, message, details: "", operatorId, workerId: "" },
        ])
      );
      return HttpResponse.json({
        type: Object.keys(errors).length === 0 ? "success" : "failure",
        operatorOutputSchemas: Object.fromEntries(
          plan.operators.map(({ operatorID }) => [
            operatorID as string,
            { "0_false": outputs[operatorID as string]?.columns ?? null },
          ])
        ),
        operatorErrors,
      });
    }),
  ];
}
