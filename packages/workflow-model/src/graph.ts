// Pure edits on the workflow spec: adding and removing operators and links, the link
// rules and property updates. Every function returns a new spec.

import { same } from "./same";
import { initialValues } from "./schema";
import type { LogicalPort, OperatorSchema, WorkflowLink, WorkflowOperator, WorkflowSpec } from "./types";

/** Initial property values: schema defaults, and the first option of required choices. */
export const schemaDefaults = (schema: OperatorSchema["jsonSchema"]) => initialValues(schema, schema);

export function newOperator(schema: OperatorSchema, displayName?: string): WorkflowOperator {
  const short = schema.custom ? "custom" : schema.operatorType;
  return {
    operatorID: `${short}-operator-${crypto.randomUUID()}`,
    operatorType: schema.operatorType,
    operatorProperties: schemaDefaults(schema.jsonSchema),
    inputPorts: schema.inputPorts.map((p, i) => ({
      portID: `input-${i}`,
      ...(p.displayName ? { displayName: p.displayName } : {}),
      ...(p.allowMultiLinks ? { allowMultiInputs: true } : {}),
    })),
    outputPorts: schema.outputPorts.map((p, i) => ({
      portID: `output-${i}`,
      ...(p.displayName ? { displayName: p.displayName } : {}),
    })),
    customDisplayName: displayName ?? schema.userFriendlyName,
  };
}

export function addOperator(spec: WorkflowSpec, op: WorkflowOperator): WorkflowSpec {
  return { ...spec, operators: [...spec.operators, op] };
}

/** Removes operators and every link touching them. */
export function deleteOperators(spec: WorkflowSpec, ids: Iterable<string>): WorkflowSpec {
  const gone = new Set(ids);
  return {
    ...spec,
    operators: spec.operators.filter(o => !gone.has(o.operatorID)),
    links: spec.links.filter(l => !gone.has(l.source.operatorID) && !gone.has(l.target.operatorID)),
  };
}

const samePort = (a: LogicalPort, b: LogicalPort) => a.operatorID === b.operatorID && a.portID === b.portID;

/** Why a link cannot be added, or undefined when it can. */
export function linkProblem(spec: WorkflowSpec, source: LogicalPort, target: LogicalPort): string | undefined {
  if (source.operatorID === target.operatorID) return "An operator cannot feed itself.";
  const from = spec.operators.find(o => o.operatorID === source.operatorID);
  const to = spec.operators.find(o => o.operatorID === target.operatorID);
  if (!from?.outputPorts?.some(p => p.portID === source.portID)) return "That output port does not exist.";
  const port = to?.inputPorts?.find(p => p.portID === target.portID);
  if (!port) return "That input port does not exist.";
  if (spec.links.some(l => samePort(l.source, source) && samePort(l.target, target))) return "Those ports are already linked.";
  if (!port.allowMultiInputs && spec.links.some(l => samePort(l.target, target))) return "That input takes a single link.";
  return undefined;
}

export function addLink(spec: WorkflowSpec, source: LogicalPort, target: LogicalPort): WorkflowSpec {
  if (linkProblem(spec, source, target)) return spec;
  const link: WorkflowLink = { linkID: `link-${crypto.randomUUID()}`, source, target };
  return { ...spec, links: [...spec.links, link] };
}

export function deleteLinks(spec: WorkflowSpec, ids: Iterable<string>): WorkflowSpec {
  const gone = new Set(ids);
  return { ...spec, links: spec.links.filter(l => !gone.has(l.linkID)) };
}

export function updateOperator(
  spec: WorkflowSpec,
  id: string,
  change: (op: WorkflowOperator) => WorkflowOperator
): WorkflowSpec {
  return { ...spec, operators: spec.operators.map(o => (o.operatorID === id ? change(o) : o)) };
}

/** The operators an execution runs and the links between them: everything enabled. */
export function enabledGraph(spec: WorkflowSpec): { operators: WorkflowOperator[]; links: WorkflowLink[] } {
  const operators = spec.operators.filter(o => !o.isDisabled);
  const ids = new Set(operators.map(o => o.operatorID));
  return { operators, links: spec.links.filter(l => ids.has(l.source.operatorID) && ids.has(l.target.operatorID)) };
}

/** Operators with no outgoing link: the ones whose results an execution shows. */
export function terminalOperators(spec: WorkflowSpec): WorkflowOperator[] {
  const { operators, links } = enabledGraph(spec);
  return operators.filter(o => !links.some(l => l.source.operatorID === o.operatorID));
}

/** The operators one spec changes or drops of another: what an edit does to operators, not to the wires between them. */
export function changedOperators(before: WorkflowSpec, after: WorkflowSpec): string[] {
  const now = new Map(after.operators.map(op => [op.operatorID, op]));
  return before.operators.filter(op => !same(op, now.get(op.operatorID))).map(op => op.operatorID);
}
