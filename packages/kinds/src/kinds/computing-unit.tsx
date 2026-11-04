import { useMutation, useQueryClient } from "@tanstack/react-query";
import { computingUnitsTerminate } from "@texera/catalog-client";
import type { ComputingUnitSpec, ComputingUnitStatus, Resource } from "@texera/catalog-client/types";
import { Badge, Button, DataTable, EmptyState, SectionTitle } from "@texera/ui";
import { Cpu, Loader2, Power, Server } from "lucide-react";
import { unwrap } from "../api";
import { keysOf } from "../queries";
import { UriChip } from "../shell/Chips";
import type { KindSpec } from "../types";

export const phaseTone = (phase: ComputingUnitStatus["phase"] | undefined) =>
  phase === "ready" ? "success" : phase === "failed" ? "danger" : phase === "pending" ? "warning" : "neutral";

/** The unit's nodes, engine and the environments built on it. */
function Nodes({ resource }: { resource: Resource }) {
  const status = resource.status as ComputingUnitStatus | undefined;
  const spec = resource.spec as ComputingUnitSpec;
  return (
    <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4" data-unit-nodes>
      {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
      <section className="space-y-2">
        <SectionTitle>Endpoint</SectionTitle>
        <p className="text-sm">
          {status?.gatewayPath ? <code>{status.gatewayPath}</code> : spec.endpoint ? <code>{spec.endpoint}</code> : "Assigned by the unit provider."}
          {status?.engine?.version && <span className="ml-2 text-xs text-muted-foreground">engine {status.engine.version}</span>}
        </p>
      </section>
      <section className="space-y-2">
        <SectionTitle>Computing nodes</SectionTitle>
        {status?.computingNodes?.length ? (
          <DataTable
            columns={[{ name: "name" }, { name: "role" }, { name: "ready" }, { name: "message" }]}
            rows={status.computingNodes.map(n => [n.name, n.role, n.ready ? "yes" : "no", n.message ?? ""])}
            className="max-h-60 rounded-lg border"
          />
        ) : (
          <EmptyState className="py-4">No nodes reported.</EmptyState>
        )}
      </section>
      {!!status?.environments?.length && (
        <section className="space-y-2">
          <SectionTitle>Environments built here</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {status.environments.map(uri => (
              <UriChip key={uri} uri={uri} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Actions({ resource }: { resource: Resource }) {
  const queryClient = useQueryClient();
  const status = resource.status as ComputingUnitStatus | undefined;
  const terminate = useMutation({
    mutationFn: () => unwrap(computingUnitsTerminate({ path: { rid: resource.metadata.rid } })),
    onSuccess: () => {
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <>
      {status && <Badge tone={phaseTone(status.phase)}>{status.phase}</Badge>}
      {status?.phase !== "terminated" && (
        <Button variant="outline" size="sm" onClick={() => confirm("Terminate this unit?") && terminate.mutate()} disabled={terminate.isPending}>
          {terminate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Terminate
        </Button>
      )}
    </>
  );
}

export const computingUnitKind: KindSpec = {
  kind: "computing-unit",
  label: "Computing unit",
  plural: "Computing units",
  icon: Cpu,
  accent: "bg-kind-computing-unit/12 text-kind-computing-unit",
  tabs: [{ value: "nodes", label: "Nodes", icon: Server, Component: Nodes }],
  Actions,
  defaultSpec: () => ({ provider: "static", endpoint: "http://localhost:28085" }) satisfies ComputingUnitSpec,
  facts: r => {
    const spec = r.spec as Partial<ComputingUnitSpec>;
    const status = r.status as Partial<ComputingUnitStatus> | undefined;
    return [spec.provider ?? "", status?.phase ?? ""].filter(Boolean);
  },
};
