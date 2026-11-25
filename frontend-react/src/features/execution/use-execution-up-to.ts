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

import { useCallback } from "react";
import type { WorkflowContent } from "@/lib/workflow/model";
import { type LogicalPlan, logicalPlan } from "@/lib/workflow/plan";
import { type Execution, unitProblem } from "./use-execution";

/** Executing a workflow up to one of its operators: why it cannot be done now, or else how to start it. */
export interface ExecutionUpTo {
  /** Why the workflow cannot be executed up to the operator now. */
  problem?: string;
  /** Starts the execution, if it can be started. */
  start: () => void;
}

/**
 * Executing the workflow up to an operator, as its card and the canvas's menu offer: the operator and what it needs
 * is all that is sent, never a target, so that each of them that is marked to keep its result keeps it. Gives, for
 * an operator, whether it can be done now and how.
 */
export function useExecutionUpTo(
  execution: Execution,
  content: WorkflowContent,
  /** Why each operator that cannot be executed cannot, by its id. */
  problems: Record<string, string>
): (operatorId: string) => ExecutionUpTo {
  const { client, snapshot, warehouse, warehouseMissing } = execution;
  return useCallback(
    (operatorId: string) => {
      const plan = logicalPlan(content, operatorId);
      const problem = problemOf({ client, snapshot, warehouseMissing }, plan, operatorId, problems);
      return {
        problem,
        start: () => {
          if (problem === undefined) void client?.start(plan, content.settings, warehouse?.id);
        },
      };
    },
    [client, snapshot, warehouse, warehouseMissing, content, problems]
  );
}

/** What keeps the plan of the workflow up to an operator from being executed now: the unit, or what the plan holds. */
function problemOf(
  execution: Pick<Execution, "client" | "snapshot" | "warehouseMissing">,
  plan: LogicalPlan,
  operatorId: string,
  problems: Record<string, string>
): string | undefined {
  const unit = unitProblem(execution);
  if (unit) return unit;
  // An operator left out of executions is in the plan of nothing.
  if (!plan.operators.some(operator => operator.operatorID === operatorId)) return "It is left out of executions.";
  if (operatorId in problems) return problems[operatorId];
  if (plan.operators.some(operator => (operator.operatorID as string) in problems)) {
    return "An operator it needs cannot be executed as it is.";
  }
  return undefined;
}
