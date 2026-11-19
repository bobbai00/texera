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

// The logical plan: a workflow as the compiling service and the engine take it (LogicalPlanPojo.scala). Each
// operator's properties are spread beside its id and type, and a link names its ports by their place on the
// operator. Both services refuse a field they do not know, so nothing else goes in.

import { type Link, type Operator, portIndex, type WorkflowContent } from "./model";

/** A port by its place on its side of the operator (PortIdentity in workflow.proto). */
export interface PortIdentity {
  id: number;
  internal: boolean;
}

export interface LogicalLink {
  fromOpId: string;
  fromPortId: PortIdentity;
  toOpId: string;
  toPortId: PortIdentity;
}

export interface LogicalPlan {
  operators: Record<string, unknown>[];
  links: LogicalLink[];
  /** The operators whose output an execution keeps for viewing. */
  opsToViewResult: string[];
  opsToReuseResult: string[];
}

/**
 * The plan of a workflow: its enabled operators and the links between them. With a target, only the target and
 * what it depends on, which is how the workflow is executed up to one operator.
 */
export function logicalPlan(content: WorkflowContent, targetOperatorId?: string): LogicalPlan {
  let operators = content.operators.filter(operator => !operator.isDisabled);
  let links = withBothEnds(content.links, operators);
  if (targetOperatorId !== undefined) {
    const needed = upstreamOf(targetOperatorId, links);
    operators = operators.filter(operator => needed.has(operator.operatorID));
    links = withBothEnds(links, operators);
  }
  return {
    operators: operators.map(operator => ({
      ...operator.operatorProperties,
      operatorID: operator.operatorID,
      operatorType: operator.operatorType,
      inputPorts: operator.inputPorts,
      outputPorts: operator.outputPorts,
    })),
    links: links.map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: { id: portIndex(link.source.portID).index, internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: portIndex(link.target.portID).index, internal: false },
    })),
    opsToViewResult: operators.filter(operator => operator.viewResult).map(operator => operator.operatorID),
    opsToReuseResult: operators.filter(operator => operator.markedForReuse).map(operator => operator.operatorID),
  };
}

function withBothEnds(links: Link[], operators: Operator[]): Link[] {
  const ids = new Set(operators.map(operator => operator.operatorID));
  return links.filter(link => ids.has(link.source.operatorID) && ids.has(link.target.operatorID));
}

/** The operator and every operator that it depends on, directly or not. */
function upstreamOf(operatorId: string, links: Link[]): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    if (found.has(id)) return;
    found.add(id);
    for (const link of links) if (link.target.operatorID === id) visit(link.source.operatorID);
  };
  visit(operatorId);
  return found;
}
