// The port positions a compilation answers by: the engine keys ports by ordinal, the spec
// by id. Used to read a CompileResult back onto the spec's operators.

import { enabledGraph } from "./graph";
import type { WorkflowSpec } from "./types";

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
  operatorIds: string[];
  links: LogicalLink[];
  /** How many input ports each operator has, so a compilation can say which are not linked. */
  inputCounts?: Record<string, number>;
}

/** The enabled part of the workflow, with links by port position. */
export function logicalPlan(spec: WorkflowSpec): LogicalPlan {
  const { operators, links } = enabledGraph(spec);
  const byId = new Map(operators.map(o => [o.operatorID, o]));
  const ordinal = (opId: string, portId: string, side: "inputPorts" | "outputPorts") =>
    byId.get(opId)?.[side]?.findIndex(p => p.portID === portId) ?? -1;
  return {
    operatorIds: operators.map(o => o.operatorID),
    inputCounts: Object.fromEntries(operators.map(o => [o.operatorID, o.inputPorts?.length ?? 0])),
    links: links.map(l => ({
      fromOpId: l.source.operatorID,
      fromPortId: { id: ordinal(l.source.operatorID, l.source.portID, "outputPorts"), internal: false },
      toOpId: l.target.operatorID,
      toPortId: { id: ordinal(l.target.operatorID, l.target.portID, "inputPorts"), internal: false },
    })),
  };
}
