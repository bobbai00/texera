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

// The user's Python environments: named lists of packages that a UDF can be executed with, which the Dashboard
// service keeps (EnvironmentResource.scala, under /environments). Installing one on a computing unit is the unit's
// business.

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * A package and the versions it may be: "==" one version, or ">=" or "<=" a bound. Without a version, any version
 * does, and the operator says nothing.
 */
export interface PackageRequirement {
  name: string;
  operator: "==" | ">=" | "<=";
  version: string;
}

/** A package as the user reads it: its name, and its operator and version when it has one. */
export function requirementText({ name, operator, version }: PackageRequirement): string {
  return version ? `${name}${operator}${version}` : name;
}

export interface Environment {
  id: number;
  name: string;
  packages: PackageRequirement[];
}

/**
 * An environment as the server sends it: its packages by name, each with its operator and version as one text, or
 * an empty text for any version.
 */
interface EnvironmentAnswer {
  veid: number;
  name: string;
  packages: Record<string, string>;
}

export const environmentsKey = ["environments"] as const;

/**
 * The names an environment may have, as the service allows them (PythonRequirements.validateName): a letter or a
 * digit, then up to 127 letters, digits, dots, dashes and underscores.
 */
export const environmentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The user's environments, the oldest first. */
export function environmentListQuery() {
  return queryOptions({
    queryKey: environmentsKey,
    queryFn: async (): Promise<Environment[]> =>
      (await api<EnvironmentAnswer[]>("/environments")).map(({ veid, name, packages }) => ({
        id: veid,
        name,
        packages: Object.entries(packages).map(([packageName, requirement]) => {
          const [, operator = "==", version = ""] = /^(==|>=|<=)?(.*)$/.exec(requirement) ?? [];
          return { name: packageName, operator: operator as PackageRequirement["operator"], version };
        }),
      })),
  });
}

/**
 * The packages as the server takes them (PythonRequirements.canonicalLines): each name with its operator and its
 * version, or with an empty text for one without a version, which is any version. The server refuses an operator
 * with nothing after it, and spaces anywhere.
 */
function packagesOf(packages: PackageRequirement[]): Record<string, string> {
  return Object.fromEntries(
    packages.map(({ name, operator, version }) => [name, version.trim() ? `${operator}${version.trim()}` : ""])
  );
}

/** Saves a new environment. The server refuses a name the user has given another environment already. */
export function createEnvironment(name: string, packages: PackageRequirement[]): Promise<void> {
  return api("/environments", { method: "POST", json: { name, packages: packagesOf(packages) }, responseType: "void" });
}

/** Renames an environment and replaces its packages. The server refuses the name of another of the user's. */
export function updateEnvironment({ id, name, packages }: Environment): Promise<void> {
  return api(`/environments/${id}`, {
    method: "PUT",
    json: { name, packages: packagesOf(packages) },
    responseType: "void",
  });
}

export function deleteEnvironment(id: number): Promise<void> {
  return api(`/environments/${id}`, { method: "DELETE", responseType: "void" });
}
