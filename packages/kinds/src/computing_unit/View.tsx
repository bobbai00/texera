import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { computingUnitsTerminate } from "@texera/catalog-client";
import type { ComputingUnitStatus } from "@texera/catalog-client/types";
import { Badge, Button, DataTable, EmptyState, ErrorNote, SectionTitle, Skeleton } from "@texera/ui";
import { Loader2, Power } from "lucide-react";
import { unwrap } from "../api";
import { KindHeader } from "../shell/KindHeader";
import { JsonBlock } from "../shell/JsonBlock";
import { metaLine } from "../shell/MetaLine";
import type { KindViewProps } from "../types";
import { unitQuery } from "./spec";

export { unitQuery };

export const phaseTone = (phase: ComputingUnitStatus["phase"]) =>
  phase === "ready" ? "success" : phase === "failed" ? "danger" : phase === "pending" ? "warning" : "neutral";

/** A computing unit: its kind, where it runs, its nodes and their readiness. */
export default function ComputingUnitView({ ref, mode }: KindViewProps) {
  const queryClient = useQueryClient();
  const { data, error } = useQuery(unitQuery(ref.rid));
  const terminate = useMutation({
    mutationFn: () => unwrap(computingUnitsTerminate({ path: { rid: ref.rid } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [{ _id: "computingUnitsRead", path: { rid: ref.rid } }] }),
  });
  if (error) return <ErrorNote error={error} prefix="Could not open this unit" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  const status = data.status;
  return (
    <div className="flex h-full min-h-0 flex-col" data-unit-view={ref.rid}>
      <KindHeader
        ref={{ kind: "computing_unit", rid: ref.rid }}
        mode={mode}
        name={data.metadata.name}
        meta={metaLine(data.metadata, [data.spec.unitKind])}
        actions={
          <>
            {status && <Badge tone={phaseTone(status.phase)}>{status.phase}</Badge>}
            {status?.phase !== "terminated" && (
              <Button variant="outline" size="sm" onClick={() => terminate.mutate()} disabled={terminate.isPending}>
                {terminate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Terminate
              </Button>
            )}
          </>
        }
      />
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4">
        {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
        <section className="space-y-2">
          <SectionTitle>Endpoint</SectionTitle>
          <p className="text-sm">
            {status?.gatewayPath ? <code>{status.gatewayPath}</code> : data.spec.endpoint ? <code>{data.spec.endpoint}</code> : "Assigned by the unit operator."}
          </p>
        </section>
        <section className="space-y-2">
          <SectionTitle>Nodes</SectionTitle>
          {status?.nodes?.length ? (
            <DataTable
              columns={[{ name: "name" }, { name: "role" }, { name: "ready" }]}
              rows={status.nodes.map(n => [n.name, n.role, n.ready ? "yes" : "no"])}
              className="max-h-60 rounded-lg border"
            />
          ) : (
            <EmptyState className="py-4">No nodes reported.</EmptyState>
          )}
        </section>
        <section className="space-y-2">
          <SectionTitle>Spec</SectionTitle>
          <JsonBlock value={data.spec} />
        </section>
        {terminate.error && <ErrorNote error={terminate.error} prefix="Could not terminate" />}
      </div>
    </div>
  );
}
