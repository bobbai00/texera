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

// Making computing units (ComputingUnitManagingResource.scala). Listing and ending them is as for every kind of
// resource, in components/resource/api.ts, where the execution's unit picker and the administrators' page find
// them too.

import { queryOptions } from "@tanstack/react-query";
import type { ComputingUnit } from "@/components/resource/api";
import { api } from "@/lib/api-client";

/** What a new unit may be: the types this deployment makes, and the limits it allows a unit of the cluster. */
export interface UnitOptions {
  types: ComputingUnit["type"][];
  cpu: string[];
  memory: string[];
  gpu: string[];
}

export function unitOptionsQuery() {
  return queryOptions({
    queryKey: ["computingUnitOptions"],
    queryFn: async (): Promise<UnitOptions> => {
      const [{ typeOptions }, limits] = await Promise.all([
        api<{ typeOptions: string[] }>("/computing-unit/types"),
        api<{ cpuLimitOptions: string[]; memoryLimitOptions: string[]; gpuLimitOptions: string[] }>(
          "/computing-unit/limits"
        ),
      ]);
      return {
        types: typeOptions.filter((type): type is ComputingUnit["type"] => type === "kubernetes" || type === "local"),
        cpu: limits.cpuLimitOptions,
        memory: limits.memoryLimitOptions,
        gpu: limits.gpuLimitOptions,
      };
    },
    staleTime: Infinity,
  });
}

/** A unit to make: one of the cluster, with its limits, or one that runs elsewhere, at an address. */
export type NewUnit =
  | { type: "kubernetes"; name: string; cpu: string; memory: string; gpu: string }
  | { type: "local"; name: string; uri: string };

/** Makes a unit for the user, and returns its id. The server says why it will not, as for a unit too many. */
export async function createComputingUnit(unit: NewUnit): Promise<number> {
  // The service reads every field, and takes "NaN" for one that does not apply to the type.
  const json =
    unit.type === "kubernetes"
      ? {
          unitType: "kubernetes",
          name: unit.name,
          cpuLimit: unit.cpu,
          memoryLimit: unit.memory,
          gpuLimit: unit.gpu,
          jvmMemorySize: "NaN",
          shmSize: "NaN",
          uri: "",
        }
      : {
          unitType: "local",
          name: unit.name,
          cpuLimit: "NaN",
          memoryLimit: "NaN",
          gpuLimit: "NaN",
          jvmMemorySize: "NaN",
          shmSize: "NaN",
          uri: unit.uri,
        };
  const created = await api<{ computingUnit: { cuid: number } }>("/computing-unit/create", { method: "POST", json });
  return created.computingUnit.cuid;
}
