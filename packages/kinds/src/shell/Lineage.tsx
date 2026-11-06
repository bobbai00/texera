import { useQueries, useQuery } from "@tanstack/react-query";
import type { Edge, Execution, Resource } from "@texera/catalog-client/types";
import { Button, EmptyState, ErrorNote, Segmented, Skeleton } from "@texera/ui";
import { Boxes, Route } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { LineageGraph } from "../lineage/LineageGraph";
import { buildLineage, type ExecutionFacts, type Level, resourcesNamed, withoutGone } from "../lineage/model";
import { executionsQuery, namedQuery } from "../lineage/queries";
import { lineageQuery, resourceQuery } from "../queries";
import type { ResourceRef } from "../types";
import { parseUri, versionOf } from "../uri";
import { whyNot } from "./OpenError";

const factsOf = (x: Execution | Resource): ExecutionFacts => {
  const spec = x.spec as Partial<Execution["spec"]>;
  const status = x.status as Partial<NonNullable<Execution["status"]>> | undefined;
  return {
    name: x.metadata.name,
    phase: status?.phase ?? "pending",
    ...(spec.workflow && versionOf(spec.workflow) !== undefined ? { vno: versionOf(spec.workflow) } : {}),
    createdAt: x.metadata.createdAt,
    ...(status?.startedAt ? { startedAt: status.startedAt } : {}),
    ...(status?.finishedAt ? { finishedAt: status.finishedAt } : {}),
  };
};

/** The executions of every workflow asked for, once all of them answered; one that cannot be listed has none. */
const allListed = (results: { isPending: boolean; data?: { items: Execution[] } }[]) => ({
  pending: results.some(r => r.isPending),
  items: results.flatMap(r => r.data?.items ?? []),
});

/** The workflows whose executions the arrows name. */
function workflowsOf(edges: Edge[]): string[] {
  const rids = new Set<string>();
  for (const e of edges)
    for (const uri of [e.from, e.to]) {
      const ref = parseUri(uri)?.ref;
      if (ref?.kind === "execution" && ref.parent) rids.add(ref.parent);
    }
  return [...rids].sort();
}

/**
 * Where a resource came from and what came out of it, as a graph: what was read on the left,
 * what was made on the right, the resource itself marked. The catalog walks its arrows both
 * ways from the resource; the graph shows them at the level of resources, or of data flow
 * (the file, the version that ran, each result). A resource or an execution that no longer
 * exists is left out, with the arrows that touched it.
 */
export function Lineage({ ref }: { ref: ResourceRef }) {
  // The page's resource by what names it, not by the object a caller happens to pass. The walk
  // starts from the resource at large, so a workflow shows its executions and every version's
  // inputs; the version on screen is the one the graph marks.
  const { kind, rid, vno, parent } = ref;
  const whole = useMemo<ResourceRef>(() => ({ kind, rid, ...(parent ? { parent } : {}) }), [kind, rid, parent]);
  const up = useQuery(lineageQuery(whole, "upstream"));
  const down = useQuery(lineageQuery(whole, "downstream"));
  const [level, setLevel] = useState<Level>("resources");
  const [showAll, setShowAll] = useState(false);
  const walked = useMemo(() => {
    const seen = new Map<string, Edge>();
    for (const e of [...(up.data?.edges ?? []), ...(down.data?.edges ?? [])])
      seen.set(`${e.from}|${e.relation}|${e.to}`, e);
    return [...seen.values()];
  }, [up.data, down.data]);
  // What each arrow names is asked for before anything is drawn: a resource that no longer
  // exists is left out with its arrows, and the cards have their names from the start.
  const names = useMemo(() => resourcesNamed(walked), [walked]);
  const named = useQueries({
    queries: names.map(namedQuery),
    combine: useCallback(
      (results: { isPending: boolean; error: unknown }[]) => ({
        pending: results.some(r => r.isPending),
        gone: names.filter((_, i) => whyNot(results[i]?.error) === "not_found"),
      }),
      [names]
    ),
  });
  const edges = useMemo(() => withoutGone(walked, new Set(named.gone)), [walked, named.gone]);
  const workflows = useMemo(() => workflowsOf(edges), [edges]);
  const listed = useQueries({ queries: workflows.map(executionsQuery), combine: allListed });
  // An execution's own page shows it whether or not its workflow's list can be read.
  const own = useQuery({ ...resourceQuery(rid), enabled: kind === "execution" });
  const executions = useMemo(() => {
    const known = new Map<string, ExecutionFacts>();
    for (const x of listed.items) known.set(x.metadata.rid, factsOf(x));
    if (own.data && !known.has(own.data.metadata.rid)) known.set(own.data.metadata.rid, factsOf(own.data));
    return known;
  }, [listed.items, own.data]);
  const graph = useMemo(
    () => buildLineage({ root: vno !== undefined ? { ...whole, vno } : whole, edges, executions, level, showAll }),
    [whole, vno, edges, executions, level, showAll]
  );
  const unfold = useCallback(() => setShowAll(true), []);

  const error = up.error ?? down.error;
  if (error) return <ErrorNote error={error} prefix="Could not load lineage" className="m-3" />;
  if (!up.data || !down.data || named.pending || listed.pending || (kind === "execution" && own.isPending))
    return <Skeleton className="m-3 h-24" />;
  if (!graph.nodes.length) return <EmptyState>No lineage recorded for this resource yet.</EmptyState>;
  return (
    <div className="relative h-full min-h-[26rem] bg-canvas" data-lineage data-level={level}>
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <Segmented
          label="Level of detail"
          value={level}
          onChange={setLevel}
          options={[
            {
              value: "resources",
              label: (
                <>
                  <Boxes /> Resources
                </>
              ),
              title: "Datasets, workflows and executions",
            },
            {
              value: "flow",
              label: (
                <>
                  <Route /> Data flow
                </>
              ),
              title: "Files, the versions that ran, and each result",
            },
          ]}
        />
        {showAll && (
          <Button
            variant="outline"
            size="sm"
            className="bg-background"
            onClick={() => setShowAll(false)}
            data-lineage-recent>
            Recent executions only
          </Button>
        )}
      </div>
      <LineageGraph graph={graph} level={level} onUnfold={unfold} />
    </div>
  );
}
