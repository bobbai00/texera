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

import { DatabaseIcon, PauseIcon, PlayIcon, ServerIcon, SquareIcon } from "lucide-react";
import { PageLink } from "@/components/layout/page-link";
import { resourceKinds } from "@/components/resource/kinds";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeStates } from "@/lib/execution/client";
import type { WorkflowContent } from "@/lib/workflow/model";
import { logicalPlan } from "@/lib/workflow/plan";
import type { Execution } from "../use-execution";

export interface ExecutionControlsProps {
  execution: Execution;
  /** The workflow to execute, as it is on the canvas now. */
  content: WorkflowContent;
  /** Whether every operator of the workflow can be executed as it is. */
  executable: boolean;
}

/**
 * Whether the execution shown is under way on the unit, which can be asked to pause, resume or stop it. One that
 * its unit does not show is the Dashboard service's to tell of, and the unit may be asked to start another.
 */
const underWayOnUnit = ({ state, followedAtDashboard }: Execution["snapshot"]) =>
  activeStates.has(state) && !followedAtDashboard;

/** Why nothing can be executed, before anything is asked: the service would refuse it. */
const noWarehouse = "This deployment keeps each execution's results in a warehouse: create one first.";

/**
 * The controls of a workflow's execution: the unit it is executed on, the buttons that start and stop it, and why
 * the unit did not do what was last asked of it.
 */
export function ExecutionControls({ execution, content, executable }: ExecutionControlsProps) {
  const { units, unit, chooseUnit, warehouses, warehouse, chooseWarehouse, warehouseMissing, client, snapshot } =
    execution;
  const { connected, state, followedAtDashboard, notice } = snapshot;
  const active = underWayOnUnit(snapshot);

  if (!unit) {
    return (
      <PageLink
        page={resourceKinds["computing-unit"].listPage}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
        Start a computing unit to execute
      </PageLink>
    );
  }

  return (
    <>
      <Select
        value={String(unit.id)}
        disabled={active}
        onValueChange={id => chooseUnit(Number(id))}>
        <SelectTrigger
          aria-label="Computing unit"
          title="The computing unit the workflow is executed on"
          className="max-w-48">
          <ServerIcon className="text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="end">
          {units.map(each => (
            <SelectItem
              key={each.id}
              value={String(each.id)}>
              {each.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {warehouse && (
        <Select
          value={String(warehouse.id)}
          disabled={active}
          onValueChange={id => chooseWarehouse(Number(id))}>
          <SelectTrigger
            aria-label="Warehouse"
            title="The warehouse the execution keeps its results in"
            className="max-w-40">
            <DatabaseIcon className="text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="end">
            {warehouses.map(each => (
              <SelectItem
                key={each.id}
                value={String(each.id)}>
                {each.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {notice && (
        <span
          role="alert"
          className="max-w-80 text-sm text-destructive">
          {notice}
        </span>
      )}
      {state === "Running" && !followedAtDashboard && (
        <Button
          variant="outline"
          onClick={() => client?.pause()}>
          <PauseIcon />
          Pause
        </Button>
      )}
      {state === "Paused" && !followedAtDashboard && (
        <Button
          variant="outline"
          onClick={() => client?.resume()}>
          <PlayIcon />
          Resume
        </Button>
      )}
      {active ? (
        <Button
          variant="destructive"
          onClick={() => client?.kill()}>
          <SquareIcon />
          Stop
        </Button>
      ) : (
        <Button
          disabled={!connected || !executable || content.operators.length === 0 || warehouseMissing}
          title={warehouseMissing ? noWarehouse : connected ? undefined : "Connecting to the computing unit…"}
          onClick={() => void client?.start(logicalPlan(content), content.settings, warehouse?.id)}>
          <PlayIcon />
          Execute
        </Button>
      )}
    </>
  );
}

export interface ExecuteToHereItemProps {
  execution: Execution;
  content: WorkflowContent;
  /** Why each operator that cannot be executed cannot, by its id. */
  problems: Record<string, string>;
  operatorId: string;
}

/**
 * The item of the canvas's menu that executes the workflow up to an operator: the operator and what it needs, which
 * is all that is sent, so that each of them that is marked to keep its result keeps it.
 */
export function ExecuteToHereItem({ execution, content, problems, operatorId }: ExecuteToHereItemProps) {
  const { client, snapshot, warehouse, warehouseMissing } = execution;
  const plan = logicalPlan(content, operatorId);
  const executable =
    plan.operators.some(operator => operator.operatorID === operatorId) &&
    plan.operators.every(operator => !((operator.operatorID as string) in problems));
  return (
    <ContextMenuItem
      disabled={!client || !snapshot.connected || underWayOnUnit(snapshot) || !executable || warehouseMissing}
      title={warehouseMissing ? noWarehouse : undefined}
      onSelect={() => void client?.start(plan, content.settings, warehouse?.id)}>
      <PlayIcon />
      Execute to here
    </ContextMenuItem>
  );
}
