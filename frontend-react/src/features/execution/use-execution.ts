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

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type ComputingUnit, computingUnitListQuery } from "@/components/resource/api";
import { useStoredState } from "@/components/use-stored-state";
import { ExecutionClient, type ExecutionSnapshot } from "@/lib/execution/client";
import { can } from "@/lib/resource";
import { type Warehouse, warehouseListQuery, type Warehouses } from "./api";

/** A workflow's execution on the computing unit that is chosen for it. */
export interface Execution {
  /** The units the user may execute on. */
  units: ComputingUnit[];
  /** The unit the workflow is executed on, if one is chosen and can be used. */
  unit: ComputingUnit | undefined;
  chooseUnit: (unitId: number) => void;
  /** The user's warehouses, on a deployment that has them, and the one the next execution keeps its results in. */
  warehouses: Warehouse[];
  warehouse: Warehouse | undefined;
  chooseWarehouse: (warehouseId: number) => void;
  /**
   * Whether the deployment keeps each execution's results in a warehouse and the user has none, so that nothing
   * can be executed: the service would refuse it.
   */
  warehouseMissing: boolean;
  /** The connection to the unit, once a unit is chosen. Starting, stopping and paging results go through it. */
  client: ExecutionClient | undefined;
  snapshot: ExecutionSnapshot;
}

const noSnapshot: ExecutionSnapshot = {
  connected: false,
  state: "Uninitialized",
  followedAtDashboard: false,
  operators: {},
  results: {},
  errors: [],
  console: {},
};
const never = () => () => {};
/** The warehouses until the deployment says whether it has them. */
const noWarehouses: Warehouses = { required: false, warehouses: [] };

/** Where the unit last chosen for a workflow is remembered in this browser, as the Angular app does. */
const unitKey = (workflowId: number) => `computing-unit-of-workflow-${workflowId}`;

/**
 * Follows the execution of a workflow. The unit is the one last chosen for the workflow in this browser, or
 * else the first one that is running; the connection to it stays open while the page is.
 */
export function useExecution(workflowId: number): Execution {
  const { data: units = [] } = useQuery(computingUnitListQuery());
  const [chosenId, chooseUnit] = useStoredState(unitKey(workflowId), kept =>
    typeof kept === "number" ? kept : undefined
  );
  // A workflow is executed on a unit that is running and that the user may change.
  const usable = units.filter(unit => unit.status === "Running" && can(unit, "edit"));
  const unit = usable.find(candidate => candidate.id === chosenId) ?? usable.at(0);
  const unitId = unit?.id;

  const client = useMemo(
    () => (unitId === undefined ? undefined : new ExecutionClient(workflowId, unitId)),
    [workflowId, unitId]
  );
  useEffect(() => {
    client?.connect();
    return () => client?.close();
  }, [client]);
  const snapshot = useSyncExternalStore(client?.subscribe ?? never, client?.snapshot ?? (() => noSnapshot));

  const { data: { required, warehouses } = noWarehouses } = useQuery(warehouseListQuery());
  const [warehouseId, setWarehouseId] = useState<number>();
  const warehouse = warehouses.find(candidate => candidate.id === warehouseId) ?? warehouses.at(0);

  return {
    units: usable,
    unit,
    chooseUnit,
    warehouses,
    warehouse,
    chooseWarehouse: setWarehouseId,
    warehouseMissing: required && warehouses.length === 0,
    client,
    snapshot,
  };
}
