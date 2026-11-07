// The page and panel of any kind, from its envelope: a header with the name, the kind's own
// tabs, then what every kind shares (the spec from its schema, versions, access, lineage,
// the envelope as JSON). A kind that needs a different page replaces this with its own View.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Badge, Button, ErrorNote, Skeleton, Tab, TabPanel, Tabs, TabsList } from "@texera/ui";
import { Braces, GitBranch, History, Settings2, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { deleteResource, updateMetadata } from "../api";
import { isAbout, keysOf, resourceQuery } from "../queries";
import { KINDS } from "../registry";
import { kindEntry, type KindViewProps, type ResourceRef } from "../types";
import { Access } from "./Access";
import { OriginChip } from "./Chips";
import { JsonBlock } from "./JsonBlock";
import { EditableName, KindHeader } from "./KindHeader";
import { Lineage } from "./Lineage";
import { metaLine } from "./MetaLine";
import { useMay } from "./may";
import { useOpenResource } from "./navigation";
import { SpecEditor } from "./SpecEditor";
import { Versions } from "./Versions";
import { OpenError } from "./OpenError";
import { useNavigate } from "@tanstack/react-router";
import { useWatch } from "../watch";

export function GenericView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(resourceQuery(ref.rid));
  if (error) return <OpenError error={error} kind={ref.kind} />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return <ResourcePage resource={data} ref={{ ...ref, kind: data.kind, parent: data.metadata.parent }} mode={mode} />;
}

export function ResourcePage({
  resource,
  ref,
  mode,
  readonly = false,
}: {
  resource: Resource;
  ref: ResourceRef;
  mode: "panel" | "page";
  /** Shows the spec without letting it be saved, for callers who know the caller may not write. */
  readonly?: boolean;
}) {
  // Only what the catalog lets this person do is offered: a viewer reads, an editor changes, an
  // owner deletes; a project itself, its name and settings, is its admins' to change.
  const project = resource.kind === "project";
  const may = useMay(resource.metadata.rid, project);
  const fixed = readonly || (project ? may.admin === false : may.write === false);
  // What others change while the page is open arrives as it happens.
  useWatch(resource.metadata.rid);
  const kind = resource.kind;
  const spec = KINDS[kind];
  const entry = kindEntry(kind);
  const queryClient = useQueryClient();
  const { expand } = useOpenResource();
  const navigate = useNavigate();
  const [vno, setVno] = useState<number | undefined>(ref.vno);
  const first = spec.tabs?.[0]?.value ?? "spec";
  const [tab, setTab] = useState(first);
  const rename = useMutation({
    mutationFn: (name: string) => updateMetadata(resource.metadata.rid, { name }, resource.metadata.etag),
    onSuccess: () => {
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteResource(resource.metadata.rid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      // What was read of it is gone with it; the page goes to where it lived, or home for a project.
      queryClient.removeQueries({ predicate: query => isAbout(query.queryKey, resource.metadata.rid) });
      if (kind === "project") void navigate({ to: "/" });
      else expand({ kind: "project", rid: resource.metadata.project });
    },
  });
  const Actions = spec.Actions;
  const Editor = spec.Editor ?? SpecEditor;
  const pinned = vno !== undefined && vno !== resource.metadata.head;
  return (
    <div className="flex h-full min-h-0 flex-col" data-resource-view={kind} data-rid={resource.metadata.rid}>
      <KindHeader
        ref={ref}
        mode={mode}
        name={<EditableName value={resource.metadata.name} onChange={name => rename.mutateAsync(name)} disabled={fixed} label={`${spec.label} name`} />}
        meta={
          <span className="flex items-center gap-1.5">
            {pinned && (
              <Badge tone="warning">
                v{vno} pinned ·{" "}
                <button type="button" className="underline" onClick={() => setVno(undefined)}>
                  back to head
                </button>
              </Badge>
            )}
            <span className="truncate">{metaLine(kind, resource.metadata, resource.metadata.description ? [resource.metadata.description] : [])}</span>
            {resource.metadata.origin && <OriginChip origin={resource.metadata.origin} />}
          </span>
        }
        actions={
          <>
            {Actions && <Actions resource={resource} readonly={fixed} />}
            {may.delete === true && (
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${spec.label.toLowerCase()}`} onClick={() => confirm(`Delete "${resource.metadata.name}"?`) && remove.mutate()} disabled={remove.isPending} data-delete>
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      {rename.error && <ErrorNote error={rename.error} prefix="Could not rename" className="m-3" />}
      {remove.error && <ErrorNote error={remove.error} prefix="Could not delete" className="m-3" />}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          {spec.tabs?.map(t => (
            <Tab key={t.value} value={t.value}>
              {t.icon && <t.icon />} {t.label}
            </Tab>
          ))}
          <Tab value="spec">
            <Settings2 /> {spec.tabs?.length ? "Settings" : spec.label}
          </Tab>
          {entry.versioned && (
            <Tab value="versions">
              <History /> Versions
            </Tab>
          )}
          <Tab value="access">
            <Users /> {project ? "People" : "Access"}
          </Tab>
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
          <Tab value="json">
            <Braces /> JSON
          </Tab>
        </TabsList>
        {spec.tabs?.map(t => (
          <TabPanel key={t.value} value={t.value} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <t.Component resource={resource} ref={{ ...ref, vno }} mode={mode} />
          </TabPanel>
        ))}
        <TabPanel value="spec" className="scrollbar-thin overflow-y-auto">
          <Editor key={`${resource.metadata.rid}:${pinned}`} resource={resource} readonly={pinned || fixed} />
        </TabPanel>
        {entry.versioned && (
          <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
            <Versions rid={resource.metadata.rid} head={resource.metadata.head} selected={vno} onSelect={setVno} />
          </TabPanel>
        )}
        <TabPanel value="access" className="scrollbar-thin overflow-y-auto">
          <Access resource={resource} />
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ ...ref, vno: vno ?? (entry.versioned && resource.metadata.head > 0 ? resource.metadata.head : undefined) }} />
        </TabPanel>
        <TabPanel value="json" className="scrollbar-thin overflow-y-auto p-3">
          <JsonBlock value={resource} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
