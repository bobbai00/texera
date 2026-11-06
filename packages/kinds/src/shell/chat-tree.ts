// What a chat made and what it worked from, as a tree to draw: a section per kind, in the
// sidebar's order; under it each resource; under a resource its versions; under a version
// what belongs to it, the executions that ran a workflow version and the files of a dataset
// version (read when the version is opened). The catalog says what counts; this arranges it.

import type { ChatResource, ChatVersion, Resource } from "@texera/catalog-client/types";
import { KIND_TABLE } from "../kinds.gen";
import { isKindId, KINDS, LIBRARY_GROUPS } from "../registry";
import type { KindId } from "../types";
import { versionOf } from "../uri";

interface Row {
  /** Unique in the tree and the same on every refresh: what remembers whether a row is open. */
  id: string;
  /** Whether the row starts open: every section, what the chat made, the newest version. */
  open: boolean;
}

export interface SectionNode extends Row {
  type: "section";
  kind: KindId;
  children: ResourceNode[];
}

export interface ResourceNode extends Row {
  type: "resource";
  kind: KindId;
  resource: Resource;
  /** The chat made it or a version of it; otherwise the chat worked from it. */
  made: boolean;
  children: (VersionNode | ExecutionNode)[];
}

export interface VersionNode extends Row {
  type: "version";
  kind: KindId;
  resource: Resource;
  version: ChatVersion;
  /** Its files go under it: a version of a kind whose versions hold files. */
  files: boolean;
  children: ExecutionNode[];
}

export interface ExecutionNode {
  type: "execution";
  id: string;
  resource: Resource;
}

export type ChatNode = SectionNode | ResourceNode | VersionNode | ExecutionNode;

/** The kinds in the sidebar's order, then the rest; asked for when a tree is made, as the registry loads the kinds that draw one. */
const kindOrder = (): KindId[] => [
  ...new Set([...LIBRARY_GROUPS.flatMap(g => g.kinds), ...(Object.keys(KINDS) as KindId[])]),
];
const HOLDS_FILES = new Set(KIND_TABLE.filter(k => k.content === "manifest").map(k => k.kind));

/** The version of its workflow an execution ran. */
const ranVersion = (execution: Resource): number | undefined => {
  const workflow = (execution.spec as { workflow?: unknown }).workflow;
  return typeof workflow === "string" ? versionOf(workflow) : undefined;
};

const newestFirst = (a: Resource, b: Resource) => b.metadata.createdAt.localeCompare(a.metadata.createdAt);

/** The chat's resources as a tree, in the catalog's order within each kind. */
export function chatTree(items: readonly ChatResource[]): SectionNode[] {
  const listed = new Set(items.map(item => item.resource.metadata.rid));
  // An execution goes under its workflow when the workflow is listed, which the catalog sees to.
  const runs = new Map<string, Resource[]>();
  const rest: ChatResource[] = [];
  for (const item of items) {
    const parent = item.resource.metadata.parent;
    if (item.resource.kind === "execution" && parent && listed.has(parent)) {
      runs.set(parent, [...(runs.get(parent) ?? []), item.resource]);
    } else {
      rest.push(item);
    }
  }
  const executions = (of: Resource[]): ExecutionNode[] =>
    [...of]
      .sort(newestFirst)
      .map(resource => ({ type: "execution", id: `execution:${resource.metadata.rid}`, resource }));

  const sections = new Map<KindId, SectionNode>();
  for (const { resource, made, versions = [] } of rest) {
    if (!isKindId(resource.kind)) continue;
    const kind = resource.kind;
    const rid = resource.metadata.rid;
    const ran = runs.get(rid) ?? [];
    const children: ResourceNode["children"] = versions.map((version, i) => ({
      type: "version",
      id: `${kind}:${rid}@${version.vno}`,
      kind,
      resource,
      version,
      files: HOLDS_FILES.has(kind),
      open: i === 0,
      children: executions(ran.filter(run => ranVersion(run) === version.vno)),
    }));
    // A run of a version the list does not hold still belongs to its workflow.
    const held = new Set(versions.map(version => version.vno));
    children.push(...executions(ran.filter(run => !held.has(ranVersion(run) ?? 0))));
    const section = sections.get(kind) ?? { type: "section", id: `section:${kind}`, kind, open: true, children: [] };
    section.children.push({ type: "resource", id: `${kind}:${rid}`, kind, resource, made, open: made, children });
    sections.set(kind, section);
  }
  return kindOrder().flatMap(kind => sections.get(kind) ?? []);
}
