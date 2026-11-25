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
// handlers keep, and the user's Python environments (EnvironmentResource.scala, /environments).

import { http, HttpResponse } from "msw/http";
import { errorResponse, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** A Python environment: a name and its packages, each "==1.2" or ">=1.0", or "" for any version. */
export interface MockEnvironment {
  veid: number;
  uid: number;
  name: string;
  packages: Record<string, string>;
}

// The grammar every environment that is saved passes (PythonRequirements.scala).
const environmentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const packageName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+!*_-]{0,63}$/;
const boundOperators = ["==", ">=", "<="];
const maxPackages = 200;

/** A text as a message of the service quotes it, cut after 64 characters. */
const quoted = (text: string) => `"${text.length > 64 ? `${text.slice(0, 64)}…` : text}"`;

/** Why pip would read the text as more than a package name or a version bound, if it would (refusal). */
function refusal(text: string): string | undefined {
  if (text.startsWith("-")) return "it starts with '-'";
  for (const character of text) {
    if (/\s/.test(character)) return "it contains whitespace";
    if (",;@/:[".includes(character)) return `it contains '${character}'`;
  }
  return undefined;
}

/** What is wrong with a package and its version spec, in the service's words, if anything is (requirementLine). */
function packageProblem(name: string, spec: string): string | undefined {
  const nameProblem = !name
    ? "the name is empty"
    : (refusal(name) ??
      (name.length > 128
        ? "a package name has at most 128 characters"
        : packageName.test(name)
          ? undefined
          : "a package name has letters, digits, '.', '_' or '-', and starts and ends with a letter or digit"));
  if (nameProblem) return `Package ${quoted(name)} is not valid: ${nameProblem}.`;
  // An empty spec is any version.
  if (!spec) return undefined;
  const operator = boundOperators.find(each => spec.startsWith(each));
  const specProblem =
    refusal(spec) ??
    (operator === undefined
      ? "a version bound starts with ==, >= or <="
      : versionPattern.test(spec.slice(operator.length))
        ? undefined
        : `the version after ${operator} has up to 64 letters, digits, '.', '+', '!', '*', '_' or '-', and starts with a letter or digit`);
  return specProblem && `Version ${quoted(spec)} of package ${quoted(name)} is not valid: ${specProblem}.`;
}

/**
 * The name, trimmed, and the packages of an environment that a request saves, or the service's 400 for the first
 * problem its grammar finds (EnvironmentResource.validated): in the name, then in the packages, by name. Packages
 * left out are none, and a version left out is any version.
 */
async function environmentOf(request: Request): Promise<Omit<MockEnvironment, "veid" | "uid"> | Response> {
  const body = (await request.json()) as Partial<Omit<MockEnvironment, "veid" | "uid">> | null;
  const name = (body?.name ?? "").trim();
  if (!name) return errorResponse(400, "An environment needs a name.");
  if (!environmentName.test(name)) {
    return errorResponse(
      400,
      `Environment name ${quoted(name)} is not valid: use 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit.`
    );
  }
  const packages = Object.entries(body?.packages ?? {}).map(([each, spec]) => [each, spec ?? ""] as const);
  if (packages.length > maxPackages) {
    return errorResponse(
      400,
      `An environment lists at most ${maxPackages} packages; this one lists ${packages.length}.`
    );
  }
  for (const [each, spec] of packages.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const problem = packageProblem(each, spec);
    if (problem) return errorResponse(400, problem);
  }
  return { name, packages: Object.fromEntries(packages) };
}

const nameTaken = (name: string) => errorResponse(409, `An environment named "${name}" already exists.`);
/** The same answer for an environment that is someone else's as for one that is not there. */
const notTheUsers = () => errorResponse(404, "This environment does not exist or is not yours.");

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

    // GET /environments -> the user's environments, the oldest first.
    http.get("/api/environments", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      return HttpResponse.json(
        db.environments
          .filter(environment => environment.uid === user.uid)
          .toSorted((a, b) => a.veid - b.veid)
          .map(({ veid, name, packages }) => ({ veid, name, packages }))
      );
    }),

    // POST /environments {name, packages} -> 201 with the new environment. The name is trimmed, and refused with
    // 400 when the rule does not allow it, and with 409 when the user has an environment of that name.
    http.post("/api/environments", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const asked = await environmentOf(request);
      if (asked instanceof Response) return asked;
      if (db.environments.some(each => each.uid === user.uid && each.name === asked.name)) return nameTaken(asked.name);
      const environment = { veid: Math.max(0, ...db.environments.map(each => each.veid)) + 1, ...asked };
      db.environments.push({ ...environment, uid: user.uid });
      return HttpResponse.json(environment, { status: 201 });
    }),

    // PUT /environments/{veid} {name, packages} -> the environment as it is now, refused as a new one is, and with
    // 404 when it is not the user's.
    http.put<{ veid: string }>("/api/environments/:veid", async ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const asked = await environmentOf(request);
      if (asked instanceof Response) return asked;
      const environment = db.environments.find(each => each.veid === Number(params.veid) && each.uid === user.uid);
      if (!environment) return notTheUsers();
      if (db.environments.some(each => each.uid === user.uid && each.name === asked.name && each !== environment)) {
        return nameTaken(asked.name);
      }
      Object.assign(environment, asked);
      return HttpResponse.json({ veid: environment.veid, ...asked });
    }),

    // DELETE /environments/{veid} -> 204, or 404 when it is not the user's.
    http.delete<{ veid: string }>("/api/environments/:veid", ({ request, params }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const before = db.environments.length;
      db.environments = db.environments.filter(each => !(each.veid === Number(params.veid) && each.uid === user.uid));
      return before === db.environments.length ? notTheUsers() : new HttpResponse(null, { status: 204 });
    }),
  ];
}
