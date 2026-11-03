// Pure edits on the workflow JSON: adding and removing operators and links, the link
// rules, moves and property updates. Every function returns a new content object.

import { initialValues } from "./schema";
import type { LogicalPort, OperatorLink, OperatorPredicate, OperatorSchema, Point, WorkflowContent } from "./types";

/** Initial property values: schema defaults, and the first option of required choices. */
export const schemaDefaults = (schema: OperatorSchema["jsonSchema"]) => initialValues(schema, schema);

export function newOperator(schema: OperatorSchema, displayName?: string): OperatorPredicate {
  return {
    operatorID: `${schema.operatorType}-operator-${crypto.randomUUID()}`,
    operatorType: schema.operatorType,
    operatorVersion: schema.operatorVersion,
    operatorProperties: schemaDefaults(schema.jsonSchema),
    inputPorts: schema.inputPorts.map((p, i) => ({
      portID: `input-${i}`,
      displayName: p.displayName ?? "",
      disallowMultiInputs: !(p.allowMultiLinks ?? false),
      isDynamicPort: false,
      dependencies: p.dependencies ?? [],
    })),
    outputPorts: schema.outputPorts.map((p, i) => ({
      portID: `output-${i}`,
      displayName: p.displayName ?? "",
      disallowMultiInputs: false,
      isDynamicPort: false,
    })),
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: displayName ?? schema.userFriendlyName,
    dynamicInputPorts: schema.dynamicInputPorts ?? false,
    dynamicOutputPorts: schema.dynamicOutputPorts ?? false,
  };
}

export function addOperator(content: WorkflowContent, op: OperatorPredicate, position: Point): WorkflowContent {
  return {
    ...content,
    operators: [...content.operators, op],
    operatorPositions: { ...content.operatorPositions, [op.operatorID]: position },
  };
}

/** Removes operators and every link touching them. */
export function deleteOperators(content: WorkflowContent, ids: Iterable<string>): WorkflowContent {
  const gone = new Set(ids);
  const operatorPositions = { ...content.operatorPositions };
  for (const id of gone) delete operatorPositions[id];
  return {
    ...content,
    operators: content.operators.filter(o => !gone.has(o.operatorID)),
    operatorPositions,
    links: content.links.filter(l => !gone.has(l.source.operatorID) && !gone.has(l.target.operatorID)),
  };
}

const samePort = (a: LogicalPort, b: LogicalPort) => a.operatorID === b.operatorID && a.portID === b.portID;

/** Why a link cannot be added, or undefined when it can. */
export function linkProblem(content: WorkflowContent, source: LogicalPort, target: LogicalPort): string | undefined {
  if (source.operatorID === target.operatorID) return "An operator cannot feed itself.";
  const from = content.operators.find(o => o.operatorID === source.operatorID);
  const to = content.operators.find(o => o.operatorID === target.operatorID);
  if (!from?.outputPorts.some(p => p.portID === source.portID)) return "That output port does not exist.";
  const port = to?.inputPorts.find(p => p.portID === target.portID);
  if (!port) return "That input port does not exist.";
  if (content.links.some(l => samePort(l.source, source) && samePort(l.target, target)))
    return "Those ports are already linked.";
  if (port.disallowMultiInputs && content.links.some(l => samePort(l.target, target)))
    return "That input takes a single link.";
  return undefined;
}

export function addLink(content: WorkflowContent, source: LogicalPort, target: LogicalPort): WorkflowContent {
  if (linkProblem(content, source, target)) return content;
  const link: OperatorLink = { linkID: `link-${crypto.randomUUID()}`, source, target };
  return { ...content, links: [...content.links, link] };
}

export function deleteLinks(content: WorkflowContent, ids: Iterable<string>): WorkflowContent {
  const gone = new Set(ids);
  return { ...content, links: content.links.filter(l => !gone.has(l.linkID)) };
}

export function moveOperators(content: WorkflowContent, moves: Record<string, Point>): WorkflowContent {
  return { ...content, operatorPositions: { ...content.operatorPositions, ...moves } };
}

export function updateOperator(
  content: WorkflowContent,
  id: string,
  change: (op: OperatorPredicate) => OperatorPredicate
): WorkflowContent {
  return { ...content, operators: content.operators.map(o => (o.operatorID === id ? change(o) : o)) };
}

/** The operators a run executes and the links between them: everything enabled. */
export function enabledGraph(content: WorkflowContent): { operators: OperatorPredicate[]; links: OperatorLink[] } {
  const operators = content.operators.filter(o => !o.isDisabled);
  const ids = new Set(operators.map(o => o.operatorID));
  return {
    operators,
    links: content.links.filter(l => ids.has(l.source.operatorID) && ids.has(l.target.operatorID)),
  };
}

/** Operators with no outgoing link: the ones whose results a run shows. */
export function terminalOperators(content: WorkflowContent): OperatorPredicate[] {
  const { operators, links } = enabledGraph(content);
  return operators.filter(o => !links.some(l => l.source.operatorID === o.operatorID));
}

/** Moves a spot down until it does not sit on top of another operator. */
export function freeSpot(content: WorkflowContent, at: Point): Point {
  const taken = Object.values(content.operatorPositions);
  const spot = { ...at };
  while (taken.some(p => Math.abs(p.x - spot.x) < 70 && Math.abs(p.y - spot.y) < 70)) spot.y += 110;
  return spot;
}
