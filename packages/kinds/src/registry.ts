// The registry: the single place that maps a kind to code. Adding a kind is one folder
// under src/ and one line here.

import { agentTemplateKind } from "./agent_template/spec";
import { computingUnitKind } from "./computing_unit/spec";
import { conversationKind } from "./conversation/spec";
import { datasetKind } from "./dataset/spec";
import { environmentKind } from "./environment/spec";
import { executionKind } from "./execution/spec";
import { mcpServerKind } from "./mcp_server/spec";
import { projectKind } from "./project/spec";
import { skillKind } from "./skill/spec";
import type { KindId, KindSpec, ResourceRef } from "./types";
import { workflowKind } from "./workflow/spec";

export const KINDS: Record<KindId, KindSpec> = {
  conversation: conversationKind,
  workflow: workflowKind,
  dataset: datasetKind,
  execution: executionKind,
  agent_template: agentTemplateKind,
  mcp_server: mcpServerKind,
  computing_unit: computingUnitKind,
  environment: environmentKind,
  project: projectKind,
  skill: skillKind,
};

/** The kinds the library lists, in sidebar order. */
export const LIBRARY_KINDS: KindId[] = [
  "workflow",
  "dataset",
  "execution",
  "agent_template",
  "mcp_server",
  "computing_unit",
  "environment",
  "skill",
  "project",
];

export const kindBySlug = (slug: string): KindSpec | undefined => Object.values(KINDS).find(k => k.slug === slug);

export const kindByLibrarySlug = (slug: string): KindSpec | undefined =>
  Object.values(KINDS).find(k => k.librarySlug === slug);

export const isKindId = (value: string): value is KindId => value in KINDS;

/** The page of a resource: `/w/<rid>`, with the version as a query when pinned. */
export function href(ref: ResourceRef): string {
  const base = `/${KINDS[ref.kind].slug}/${encodeURIComponent(ref.rid)}`;
  return ref.vno !== undefined ? `${base}?vno=${ref.vno}` : base;
}

/** `kind:rid[@vno]` → ref; undefined when malformed or unknown. */
export function parseRef(text: string | undefined): ResourceRef | undefined {
  if (!text) return undefined;
  const m = /^([a-z_]+):([^@]+)(?:@(\d+))?$/.exec(text);
  if (!m?.[1] || !m[2] || !isKindId(m[1])) return undefined;
  return { kind: m[1], rid: m[2], ...(m[3] ? { vno: Number(m[3]) } : {}) };
}
