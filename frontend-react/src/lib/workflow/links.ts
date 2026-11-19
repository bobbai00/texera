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

import type { PortRef, WorkflowContent } from "./model";
import { portIndex } from "./model";

/**
 * Why a link from one port to another may not be made, or undefined when it may: it goes from an output port to
 * an input port of another operator, it is not there already, and an input port that takes one link has none.
 */
export function linkProblem(content: WorkflowContent, source: PortRef, target: PortRef): string | undefined {
  const from = content.operators.find(operator => operator.operatorID === source.operatorID);
  const to = content.operators.find(operator => operator.operatorID === target.operatorID);
  const output = from?.outputPorts.find(port => port.portID === source.portID);
  const input = to?.inputPorts.find(port => port.portID === target.portID);
  if (!output || !input) return "A link goes from an output port to an input port.";
  if (source.operatorID === target.operatorID) return "An operator cannot be linked to itself.";
  const intoTarget = content.links.filter(
    link => link.target.operatorID === target.operatorID && link.target.portID === target.portID
  );
  const same = intoTarget.some(
    link => link.source.operatorID === source.operatorID && link.source.portID === source.portID
  );
  if (same) return "These two ports are linked already.";
  if (input.disallowMultiInputs && intoTarget.length > 0) return "This input port takes one link only.";
  return undefined;
}

/** The id of the next port on a side of an operator: ports are numbered in order, from 0. */
export function nextPortId(ports: { portID: string }[], side: "input" | "output"): string {
  const taken = ports.map(port => portIndex(port.portID).index);
  return `${side}-${Math.max(-1, ...taken) + 1}`;
}
