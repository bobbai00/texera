// A project: where work is managed from. It inherits from one other, its base, up to Texera: its
// people read and use what the projects up its chain hold, and its settings fill in what its own
// leave out. Its admins change the project itself; its members work in it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSettings, Resource } from "@texera/catalog-client/types";
import { Badge, Button, ErrorNote, NativeSelect, SectionTitle, Skeleton } from "@texera/ui";
import { Check, FolderKanban, LayoutList } from "lucide-react";
import type { ReactNode } from "react";
import { updateMetadata } from "../api";
import { ResourceTable } from "../library/ResourceTable";
import { keysOf, meQuery, projectSettingsQuery, searchQuery } from "../queries";
import { ProjectScope, projectsQuery, useWorkingProject } from "../scope";
import { UriChip } from "../shell/Chips";
import { useMay } from "../shell/may";
import { SpecEditor } from "../shell/SpecEditor";
import type { KindSpec } from "../types";

/** Everything in the project the caller may read. */
function Contents({ resource }: { resource: Resource }) {
  const { data, isPending } = useQuery(searchQuery({ project: resource.metadata.rid, limit: 200 }));
  return (
    <ProjectScope project={resource.metadata.rid}>
      <div className="scrollbar-thin overflow-y-auto p-4">
        <ResourceTable resources={data?.items.filter(r => r.kind !== "project")} loading={isPending} />
      </div>
    </ProjectScope>
  );
}

/**
 * Whether the person works in this project, and the one click that makes it so: what they
 * make from then on goes into it. Looking at a project's page does not change where they work.
 */
function Actions({ resource }: { resource: Resource }) {
  const { current, pick } = useWorkingProject();
  // Working in a project puts what one makes into it: only someone who may add to it works there.
  const may = useMay(resource.metadata.rid);
  if (current === undefined) return null;
  if (current === resource.metadata.rid)
    return (
      <Badge tone="success" data-working-here>
        <Check className="size-3" /> You work here
      </Badge>
    );
  if (may.write !== true) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void pick(resource.metadata.rid).catch(() => undefined)}
      data-work-here>
      Work in this project
    </Button>
  );
}

/** What a value of a project's settings is, as the page says it. */
type Show = (settings: ProjectSettings) => ReactNode;

const uri = (value: string | undefined) => (value ? <UriChip uri={value} /> : undefined);
const uris = (values: string[] | undefined) =>
  values?.length ? (
    <span className="flex flex-wrap gap-1">
      {values.map(v => (
        <UriChip key={v} uri={v} />
      ))}
    </span>
  ) : undefined;
const text = (value: string | undefined) => (value ? <span className="text-sm">{value}</span> : undefined);

/** The settings a project's work runs with, by the path its sources name them by. */
const ROWS: { path: string; label: string; show: Show }[] = [
  { path: "branding.name", label: "Name", show: s => text(s.branding.name) },
  { path: "branding.logoUrl", label: "Logo", show: s => (s.branding.logoUrl ? <img src={s.branding.logoUrl} alt="" className="size-6 rounded" /> : undefined) },
  { path: "defaults.agentTemplate", label: "Agent", show: s => uri(s.defaults.agentTemplate) },
  { path: "defaults.modelEndpoint", label: "Model", show: s => uri(s.defaults.modelEndpoint) },
  { path: "defaults.mcpServers", label: "Add-ons", show: s => uris(s.defaults.mcpServers) },
  { path: "defaults.workMode", label: "Work mode", show: s => text(s.defaults.workMode) },
  { path: "defaults.computingUnit", label: "Computing unit", show: s => uri(s.defaults.computingUnit) },
  { path: "defaults.profile", label: "Profile of a new unit", show: s => uri(s.defaults.profile) },
  { path: "defaults.warehouse", label: "Warehouse", show: s => uri(s.defaults.warehouse) },
  { path: "limits.results", label: "Results kept for", show: s => text(s.limits.results) },
  { path: "limits.warehouseEndpoints", label: "Stores allowed", show: s => (s.limits.warehouseEndpoints ? text(s.limits.warehouseEndpoints.join(", ") || "none") : undefined) },
];

/** When nothing up the chain sets a value, what holds instead. */
const UNSET: Record<string, string> = {
  "defaults.modelEndpoint": "the agent's own",
  "defaults.workMode": "auto",
  "limits.results": "forever",
  "limits.warehouseEndpoints": "only the deployment's own store",
};

/** What the project's work runs with, each value with the project of the chain that set it. */
function Effective({ settings, rid }: { settings: ProjectSettings; rid: string }) {
  const nameOf = (project: string) => settings.chain.find(p => p.rid === project)?.name ?? "another project";
  return (
    <section className="space-y-2" data-effective-settings>
      <SectionTitle>What its work runs with</SectionTitle>
      <p className="text-xs text-muted-foreground">
        Each value comes from the nearest project that sets it, along {settings.chain.map(p => p.name).join(" › ")}. A limit is the strictest set along the way.
      </p>
      <dl className="divide-y rounded-lg border text-sm">
        {ROWS.map(row => {
          const value = row.show(settings);
          const from = settings.from[row.path];
          return (
            <div key={row.path} className="flex items-center gap-3 px-3 py-2" data-setting={row.path}>
              <dt className="w-40 shrink-0 text-xs text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 flex-1 truncate">{value ?? <span className="text-xs text-muted-foreground">{UNSET[row.path] ?? "none"}</span>}</dd>
              {from && (
                <span className="shrink-0 text-xs text-muted-foreground" data-setting-from={from === rid ? "here" : nameOf(from)}>
                  {from === rid ? "set here" : `from ${nameOf(from)}`}
                </span>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * What the project inherits from, and for its admins the choice of another: a project they
 * administer too, or Texera. A base's own admins may also send a project back to Texera.
 */
function Inherits({ resource, readonly }: { resource: Resource; readonly?: boolean }) {
  const rid = resource.metadata.rid;
  const base = resource.metadata.base;
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery());
  const { data: projects } = useQuery(projectsQuery());
  const change = useMutation({
    mutationFn: (next: string) => updateMetadata(rid, { base: next }, resource.metadata.etag),
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: [{ _id: "projectsSettings" }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
    },
  });
  if (!base) {
    return (
      <section className="space-y-1" data-inherits="nothing">
        <SectionTitle>Inherits from</SectionTitle>
        <p className="text-sm text-muted-foreground">Nothing: every project inherits from {resource.metadata.name}, and what it holds and sets is theirs unless they set their own.</p>
      </section>
    );
  }
  // A project of the person's own, or Texera: one they are sure to administer or may inherit from.
  const choices = (projects?.items ?? []).filter(
    p => p.metadata.rid !== rid && (p.metadata.rid === me?.rootProject || p.metadata.owner === me?.principal.pid)
  );
  if (!choices.some(p => p.metadata.rid === base) && projects) {
    const current = projects.items.find(p => p.metadata.rid === base);
    if (current) choices.unshift(current);
  }
  return (
    <section className="space-y-2" data-inherits={base}>
      <SectionTitle>Inherits from</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        {readonly || !projects ? (
          <UriChip uri={`texera://projects/${base}`} emphasis />
        ) : (
          <NativeSelect value={base} onChange={e => change.mutate(e.target.value)} disabled={change.isPending} aria-label="Inherits from" data-base-select>
            {choices.map(p => (
              <option key={p.metadata.rid} value={p.metadata.rid}>
                {p.metadata.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Its people read and use what the projects up its chain hold, and change none of it.</p>
      {change.error && <ErrorNote error={change.error} prefix="Could not change what it inherits from" />}
    </section>
  );
}

/** A project's settings: what it inherits, what its work runs with, and what it sets itself. */
function Settings({ resource, readonly }: { resource: Resource; readonly?: boolean }) {
  const { data: settings, error } = useQuery(projectSettingsQuery(resource.metadata.rid));
  return (
    <div className="space-y-6 p-4" data-project-settings>
      <Inherits resource={resource} readonly={readonly} />
      {error && <ErrorNote error={error} prefix="Could not read its settings" />}
      {settings ? <Effective settings={settings} rid={resource.metadata.rid} /> : !error && <Skeleton className="h-48" />}
      <section className="space-y-2" data-own-settings>
        <SectionTitle>Set here</SectionTitle>
        <p className="text-xs text-muted-foreground">
          {readonly ? "Its admins set these." : "What this project sets wins over what it inherits; a limit may only narrow what it inherits."}
        </p>
        <div className="-mx-4">
          <SpecEditor resource={resource} readonly={readonly} />
        </div>
      </section>
    </div>
  );
}

export const projectKind: KindSpec = {
  kind: "project",
  label: "Project",
  plural: "Projects",
  icon: FolderKanban,
  accent: "bg-kind-project/12 text-kind-project",
  tabs: [{ value: "contents", label: "Contents", icon: LayoutList, Component: Contents }],
  Editor: Settings,
  Actions,
  defaultSpec: () => ({}),
};
