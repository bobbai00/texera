// What a workflow's operators read from the catalog: the datasets and models their settings name.
// On a canvas each is a small chip above the operator that names it, joined to it by a dashed
// line. They are read off the settings, so they are in no version and nobody moves or edits them.
// Pure, so it is tested on its own.

import type { Edge, Node } from "@xyflow/react";
import { CARD } from "./layout";
import type { OperatorNode } from "./to-flow";
import type { Positions, WorkflowOperator, WorkflowSpec } from "./types";

/** The resource a URI names, without a version or a path inside it. */
export const baseOf = (uri: string) => /^texera:\/\/[a-z-]+\/[0-9a-f-]{36}/.exec(uri)?.[0] ?? uri;

/** The texera:// names a value holds, however deep, with the path of a file when one is named. */
export function namesIn(value: unknown, out: { base: string; path?: string }[] = []): { base: string; path?: string }[] {
  if (typeof value === "string" && value.startsWith("texera://")) {
    const path = /\/files\/(.+)$/.exec(value)?.[1];
    out.push({ base: baseOf(value), path: path ? decodeURIComponent(path) : undefined });
  } else if (Array.isArray(value)) for (const v of value) namesIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) namesIn(v, out);
  return out;
}

/** A dataset or model an operator's settings name. */
export interface ResourceUse {
  /** The resource, at the version named when one is. */
  uri: string;
  kind: "dataset" | "model";
  /** The file of it, when one is named. */
  file?: string;
}

const NAMED = /^(texera:\/\/(datasets|models)\/[0-9a-f-]{36}(?:@\d+)?)(?:\/files\/(.+))?$/;

/** The datasets and models an operator's settings name, each once, in the order the settings do. */
export function resourcesOf(op: Pick<WorkflowOperator, "operatorProperties">): ResourceUse[] {
  const found = new Map<string, ResourceUse>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      const m = NAMED.exec(value);
      if (m && !found.has(m[1] as string))
        found.set(m[1] as string, {
          uri: m[1] as string,
          kind: m[2] === "models" ? "model" : "dataset",
          ...(m[3] ? { file: decodeURIComponent(m[3]) } : {}),
        });
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(op.operatorProperties ?? {});
  return [...found.values()];
}

/** A resource's chip on a canvas, and the room between it and what stands under it. */
export const RESOURCE_CHIP = { width: 200, height: 36, gap: 22 };

/** How far above an operator its chips reach, at most, on a canvas of this spec. */
export const resourceRoom = (spec: WorkflowSpec): number =>
  Math.max(0, ...spec.operators.map(op => resourcesOf(op).length)) * (RESOURCE_CHIP.height + RESOURCE_CHIP.gap);

export interface ResourceNodeData extends Record<string, unknown>, ResourceUse {}

export type ResourceNode = Node<ResourceNodeData, "resource">;

/** What a canvas draws: operators, and when asked the resources they use. */
export type CanvasNode = OperatorNode | ResourceNode;

/** The handle on an operator's card that a resource's dashed line ends at. */
export const RESOURCE_HANDLE = "resource";

/** The chips of a spec's operators and their lines, each chip above its operator, drawn where `positions` put it. */
export function resourceLayer(spec: WorkflowSpec, positions: Positions): { nodes: ResourceNode[]; edges: Edge[] } {
  const nodes: ResourceNode[] = [];
  const edges: Edge[] = [];
  const { width, height, gap } = RESOURCE_CHIP;
  for (const op of spec.operators) {
    const at = positions[op.operatorID];
    if (!at) continue;
    resourcesOf(op).forEach((use, i) => {
      const id = `resource:${op.operatorID}:${use.uri}`;
      nodes.push({
        id,
        type: "resource",
        position: { x: at.x + (CARD.width - width) / 2, y: at.y - (i + 1) * (height + gap) },
        draggable: false,
        selectable: false,
        connectable: false,
        data: { ...use },
      });
      edges.push({
        id: `${id}:line`,
        source: id,
        target: op.operatorID,
        targetHandle: RESOURCE_HANDLE,
        type: "straight",
        selectable: false,
        focusable: false,
        deletable: false,
        markerEnd: undefined,
        style: { strokeWidth: 1.25, strokeDasharray: "4 4" },
      });
    });
  }
  return { nodes, edges };
}
