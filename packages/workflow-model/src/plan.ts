// The logical plan the compiler and the engine take: operators with their properties
// spread flat, links by port position. The engine rejects fields it does not know, so
// nothing else goes in.

import { enabledGraph } from "./graph";
import type { OperatorPredicate, WorkflowContent } from "./types";

export interface PortIdentity {
  id: number;
  internal: false;
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
  opsToViewResult: string[];
  opsToReuseResult: string[];
}

const toLogical = (op: OperatorPredicate) => ({
  ...op.operatorProperties,
  operatorID: op.operatorID,
  operatorType: op.operatorType,
  inputPorts: op.inputPorts,
  outputPorts: op.outputPorts,
});

/** The enabled part of the workflow, or only what `targetOperatorId` depends on ("run up to here"). */
export function logicalPlan(content: WorkflowContent, targetOperatorId?: string): LogicalPlan {
  let { operators, links } = enabledGraph(content);
  if (targetOperatorId) {
    const keep = new Set<string>();
    const visit = (id: string) => {
      if (keep.has(id)) return;
      keep.add(id);
      for (const l of links) if (l.target.operatorID === id) visit(l.source.operatorID);
    };
    visit(targetOperatorId);
    operators = operators.filter(o => keep.has(o.operatorID));
    links = links.filter(l => keep.has(l.source.operatorID) && keep.has(l.target.operatorID));
  }
  const byId = new Map(operators.map(o => [o.operatorID, o]));
  const ordinal = (opId: string, portId: string, side: "inputPorts" | "outputPorts") =>
    byId.get(opId)?.[side].findIndex(p => p.portID === portId) ?? -1;
  return {
    operators: operators.map(toLogical),
    links: links.map(l => ({
      fromOpId: l.source.operatorID,
      fromPortId: { id: ordinal(l.source.operatorID, l.source.portID, "outputPorts"), internal: false },
      toOpId: l.target.operatorID,
      toPortId: { id: ordinal(l.target.operatorID, l.target.portID, "inputPorts"), internal: false },
    })),
    opsToViewResult: operators.filter(o => o.viewResult).map(o => o.operatorID),
    opsToReuseResult: operators.filter(o => o.markedForReuse).map(o => o.operatorID),
  };
}
