import { useMutation, useQueryClient } from "@tanstack/react-query";
import { computingUnitsTerminate } from "@texera/catalog-client";
import type { ComputingUnitSpec, ComputingUnitStatus, Resource } from "@texera/catalog-client/types";
import { Badge, Button, DataTable, EmptyState, Field, NativeSelect, SectionTitle } from "@texera/ui";
import { Cpu, Loader2, Power, Server } from "lucide-react";
import { useId } from "react";
import { unwrap } from "../api";
import { keysOf } from "../queries";
import { UriChip } from "../shell/Chips";
import type { KindSpec } from "../types";
import { CPU_CHOICES, MEMORY_CHOICES, sized, sizeOf } from "./unit-size";

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
          {spec.endpoint ? <code>{spec.endpoint}</code> : "Assigned by the unit provider."}
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

function Actions({ resource, readonly }: { resource: Resource; readonly?: boolean }) {
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
      {!readonly && status?.phase !== "terminated" && (
        <Button variant="outline" size="sm" onClick={() => confirm("Terminate this unit?") && terminate.mutate()} disabled={terminate.isPending}>
          {terminate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Terminate
        </Button>
      )}
    </>
  );
}

/** What a new unit reserves on the cluster: asked when it is made, changed later in its settings. */
function Size({ spec, onChange }: { spec: unknown; onChange: (spec: unknown) => void }) {
  const unit = spec as ComputingUnitSpec;
  const size = sizeOf(unit);
  const ids = { memory: useId(), cpu: useId() };
  return (
    <div className="grid grid-cols-2 gap-3" data-unit-size>
      <Field label="Memory" htmlFor={ids.memory}>
        <NativeSelect id={ids.memory} value={size.memory} onChange={e => onChange(sized(unit, { memory: e.target.value }))} className="w-full" data-field="memory">
          {MEMORY_CHOICES.map(c => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="CPU" htmlFor={ids.cpu} help="Shared reserves no core of its own.">
        <NativeSelect id={ids.cpu} value={size.cpu} onChange={e => onChange(sized(unit, { cpu: e.target.value }))} className="w-full" data-field="cpu">
          {CPU_CHOICES.map(c => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </div>
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
  // A new unit is one the platform runs: on Kubernetes a Deployment the catalog reconciles.
  defaultSpec: () => ({ provider: "kubernetes", computingNodes: [{ name: "master", role: "master", memory: "2Gi" }] }) satisfies ComputingUnitSpec,
  CreateFields: Size,
  facts: r => {
    const spec = r.spec as Partial<ComputingUnitSpec>;
    const status = r.status as Partial<ComputingUnitStatus> | undefined;
    return [spec.provider ?? "", status?.phase ?? ""].filter(Boolean);
  },
};
