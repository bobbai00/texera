import type { ChatResource, ChatVersion, Resource } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { type ChatNode, chatTree } from "./chat-tree";

const id = (n: number) => `0b7a1c2d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minute: number) => `2026-11-06T10:${String(minute).padStart(2, "0")}:00Z`;
const plural: Record<string, string> = {
  workflow: "workflows",
  dataset: "datasets",
  "computing-unit": "computing-units",
  profile: "profiles",
  execution: "executions",
};

const resource = (
  kind: string,
  n: number,
  name: string,
  extra: Partial<Resource["metadata"]> = {},
  spec: Record<string, unknown> = {}
): Resource =>
  ({
    apiVersion: "catalog.texera.apache.org/v1",
    kind,
    metadata: {
      rid: id(n),
      uri: `texera://${plural[kind]}/${id(n)}`,
      name,
      project: id(0),
      owner: id(0),
      visibility: "private",
      head: 0,
      etag: "e",
      createdBy: id(0),
      createdAt: at(n),
      updatedAt: at(n),
      ...extra,
    },
    spec,
  }) as Resource;

const version = (rid: string, vno: number, made: boolean): ChatVersion =>
  ({
    rid,
    uri: `texera://x/${rid}@${vno}`,
    vno,
    contentKind: "spec",
    digest: "sha256:0",
    createdBy: id(0),
    createdAt: at(vno),
    made,
  }) as ChatVersion;

const item = (r: Resource, made: boolean, versions?: [vno: number, made: boolean][]): ChatResource => ({
  resource: r,
  made,
  ...(versions ? { versions: versions.map(([vno, m]) => version(r.metadata.rid, vno, m)) } : {}),
});

const run = (n: number, workflow: Resource, vno: number) =>
  resource(
    "execution",
    n,
    `run ${n}`,
    { parent: workflow.metadata.rid },
    { workflow: `${workflow.metadata.uri}@${vno}` }
  );

/** The tree in words, one line per row, indented by depth; `(open)` marks a row that starts open. */
function drawn(nodes: ChatNode[], depth = 0): string[] {
  return nodes.flatMap(node => {
    const pad = "  ".repeat(depth);
    if (node.type === "execution") return [`${pad}${node.resource.metadata.name}`];
    const label =
      node.type === "section"
        ? node.kind
        : node.type === "resource"
          ? `${node.resource.metadata.name}${node.made ? "" : " ·worked from"}`
          : `v${node.version.vno}${node.version.made ? "" : " ·worked from"}${node.files ? " ·files" : ""}`;
    return [`${pad}${label}${node.open ? " (open)" : ""}`, ...drawn(node.children, depth + 1)];
  });
}

describe("chatTree", () => {
  const ranks = resource("workflow", 1, "ranks");
  const byHand = resource("workflow", 2, "by hand");
  const iris = resource("dataset", 3, "iris");
  const unit = resource("computing-unit", 4, "humanize unit");
  const small = resource("profile", 5, "small");

  it("sections by kind in the sidebar's order; a run under the workflow version it ran", () => {
    const tree = chatTree([
      item(unit, true),
      item(run(9, ranks, 2), true),
      item(run(8, ranks, 2), true),
      item(run(7, byHand, 1), true),
      item(ranks, true, [
        [2, true],
        [1, true],
      ]),
      item(byHand, false, [[1, false]]),
      item(iris, false, [[1, false]]),
      item(small, false, [[1, false]]),
    ]);
    expect(drawn(tree)).toEqual([
      "workflow (open)",
      "  ranks (open)",
      "    v2 (open)",
      "      run 9",
      "      run 8",
      "    v1",
      "  by hand ·worked from",
      "    v1 ·worked from (open)",
      "      run 7",
      "dataset (open)",
      "  iris ·worked from",
      "    v1 ·worked from ·files (open)",
      "computing-unit (open)",
      "  humanize unit (open)",
      "profile (open)",
      "  small ·worked from",
      "    v1 ·worked from (open)",
    ]);
  });

  it("keeps a run whose version is not listed with its workflow, and one whose workflow is not listed on its own", () => {
    const orphan = resource("workflow", 6, "not listed");
    const tree = chatTree([
      item(run(9, ranks, 3), true),
      item(run(8, orphan, 1), true),
      item(ranks, true, [[2, true]]),
    ]);
    expect(drawn(tree)).toEqual([
      "workflow (open)",
      "  ranks (open)",
      "    v2 (open)",
      "    run 9",
      "execution (open)",
      "  run 8 (open)",
    ]);
  });

  it("gives every row an id of its own that stays the same", () => {
    const items = [
      item(run(9, ranks, 2), true),
      item(ranks, true, [
        [2, true],
        [1, true],
      ]),
      item(iris, false, [[1, false]]),
    ];
    const ids = (nodes: ChatNode[]): string[] =>
      nodes.flatMap(n => [n.id, ...("children" in n ? ids(n.children) : [])]);
    const first = ids(chatTree(items));
    expect(new Set(first).size).toBe(first.length);
    expect(ids(chatTree(items))).toEqual(first);
  });

  it("is empty for a chat that made and used nothing", () => {
    expect(chatTree([])).toEqual([]);
  });
});
