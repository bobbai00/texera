import type { EnvironmentSpec, EnvironmentStatus, Resource } from "@texera/catalog-client/types";
import { Badge, EmptyState, timeAgo } from "@texera/ui";
import { Hammer, Package } from "lucide-react";
import { UriChip } from "../shell/Chips";
import type { KindSpec } from "../types";

/** Where each version of the environment has been built, and how it went. */
function Builds({ resource }: { resource: Resource }) {
  const builds = (resource.status as EnvironmentStatus | undefined)?.builds ?? [];
  if (!builds.length) return <EmptyState>Not built anywhere yet; the first execution that needs it builds it.</EmptyState>;
  return (
    <ul className="divide-y" data-builds>
      {builds.map(b => (
        <li key={`${b.computingUnit}:${b.vno}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
          <span className="font-medium">v{b.vno}</span>
          <span className="text-muted-foreground">on</span>
          <UriChip uri={b.computingUnit} />
          <Badge tone={b.state === "ready" ? "success" : b.state === "failed" ? "danger" : "warning"}>{b.state}</Badge>
          {b.message && <span className="min-w-0 truncate text-xs text-muted-foreground">{b.message}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{timeAgo(b.at)}</span>
        </li>
      ))}
    </ul>
  );
}

export const environmentKind: KindSpec = {
  kind: "environment",
  label: "Environment",
  plural: "Environments",
  icon: Package,
  accent: "bg-kind-environment/12 text-kind-environment",
  tabs: [{ value: "builds", label: "Builds", icon: Hammer, Component: Builds }],
  defaultSpec: () => ({ python: { packages: [] } }) satisfies EnvironmentSpec,
  facts: r => {
    const n = (r.spec as Partial<EnvironmentSpec>).python?.packages?.length ?? 0;
    const ready = ((r.status as EnvironmentStatus | undefined)?.builds ?? []).filter(b => b.state === "ready").length;
    return [`${n} package${n === 1 ? "" : "s"}`, ...(ready ? [`built on ${ready} unit${ready === 1 ? "" : "s"}`] : [])];
  },
};
