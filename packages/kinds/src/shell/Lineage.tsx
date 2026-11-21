// Where a resource came from and what came of it: the lineage graph, drawn as it is beside a chat,
// around the resource, which is marked, with the row of the version on screen. A click opens
// what it names beside the page: a version at that version, so a workflow version on its canvas;
// an execution, or the execution a result came out of.

import { useQuery } from "@tanstack/react-query";
import { resourcesGraphOptions } from "@texera/catalog-client/query";
import { EmptyState, ErrorNote, Skeleton } from "@texera/ui";
import { entryFor } from "../graph/focus-trail";
import { rowId } from "../graph/model";
import { ResourceGraph } from "../graph/ResourceGraph";
import type { KindId, ResourceRef } from "../types";
import { refOf, uriOf } from "../uri";
import { useOpenResource } from "./navigation";

/** The kinds a lineage graph is drawn for: what is read, called, executed or made. */
export const LINEAGE_KINDS: ReadonlySet<KindId> = new Set<KindId>([
  "dataset",
  "model",
  "operator",
  "workflow",
  "execution",
]);

const GOING = new Set(["pending", "provisioning", "running"]);

export function Lineage({ ref }: { ref: ResourceRef }) {
  const { kind, rid, vno, parent } = ref;
  const { beside } = useOpenResource();
  const { data, error } = useQuery({
    ...resourcesGraphOptions({ path: { rid } }),
    // While an execution of it goes, the graph follows it.
    refetchInterval: q => (q.state.data?.executions.some(x => GOING.has(x.phase)) ? 2_500 : false),
  });
  if (error) return <ErrorNote error={error} prefix="Could not load the lineage" className="m-3" />;
  if (!data) return <Skeleton className="m-3 h-24" />;
  if (!data.nodes.length) return <EmptyState>No lineage recorded for this resource yet.</EmptyState>;
  const root = uriOf({ kind, rid, ...(parent ? { parent } : {}) });
  return (
    <ResourceGraph
      graph={data}
      root={root}
      {...(vno !== undefined ? { rootRow: rowId(root, vno) } : {})}
      className="h-full min-h-[26rem]"
      lineage
      onOpen={(id, _from, view) => {
        const entry = entryFor(view, id);
        if (entry?.kind === "resource" && !(entry.id === root && entry.ref.vno === undefined)) beside(entry.ref);
        if (entry?.kind === "run" && id !== root) {
          const execution = refOf(id);
          if (execution) beside(execution);
        }
        if (entry?.kind === "table") {
          const by = view.results.get(id)?.run;
          const execution = by ? refOf(by) : undefined;
          if (execution) beside(execution);
        }
      }}
    />
  );
}
