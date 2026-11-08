// A workflow's step as a row of its card says it, zoomed in: what it does, the dataset file,
// model or function it names, and its settings in short. The row is read at a glance, so a
// setting is its value, not JSON: `where glucose < 70`, `by participant`, `keep 6 columns`.

import type { GraphNode, GraphStep } from "@texera/catalog-client/types";
import { baseOf } from "./model";

export interface StepLine {
  /** What the step does: scan, filter, predict, or a function's name. */
  op: string;
  /** Its settings, in short. */
  text: string;
  /** The model or function it uses, as the graph has it. */
  uses?: GraphNode;
  /** The file it reads, by path, for a scan. */
  file?: string;
  /** The URI of what it names, when the graph has no node for it: a dataset or a model. */
  names?: string;
}

const shown = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(shown).join(", ");
  if (typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k} ${shown(x)}`)
      .join(", ");
  return String(v);
};

/** A setting as a row says it: a list of columns by its count when it is long. */
function setting(key: string, value: unknown): string {
  if (Array.isArray(value) && value.length > 3 && value.every(v => typeof v === "string" && !v.includes("=")))
    return `${key} ${value.length} columns`;
  return `${key} ${shown(value)}`;
}

const fileOf = (settings: Record<string, unknown>) => {
  const f = settings.file ?? settings.fileName;
  return typeof f === "string" ? f : undefined;
};

/** How a step's row reads. `nodes` are the graph's, by URI. */
export function lineOf(step: GraphStep, nodes: Map<string, GraphNode>): StepLine {
  const settings = (step.settings ?? {}) as Record<string, unknown>;
  const rest = (skip: string[]) =>
    Object.entries(settings)
      .filter(([k]) => !skip.includes(k))
      .map(([k, v]) => setting(k, v))
      .join(" · ");
  if (step.type.startsWith("texera://")) {
    const fn = nodes.get(baseOf(step.type));
    return { op: fn?.name ?? "function", text: rest([]), uses: fn };
  }
  if (step.type === "predict") {
    const model = typeof settings.model === "string" ? settings.model : undefined;
    return { op: "predict", text: rest(["model"]), uses: model ? nodes.get(baseOf(model)) : undefined, names: model };
  }
  const file = fileOf(settings);
  if (file) {
    const path = /\/files\/(.+)$/.exec(file)?.[1];
    const owner = nodes.get(baseOf(file));
    return {
      op: "scan",
      text: path ? decodeURIComponent(path) : file,
      file: path ? decodeURIComponent(path) : undefined,
      uses: owner?.role === "model" ? owner : undefined,
      names: file,
    };
  }
  return { op: step.type, text: rest([]) };
}
