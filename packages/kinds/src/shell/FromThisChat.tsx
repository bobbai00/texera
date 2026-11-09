// What a chat made and what it worked from, as a tree that folds at every level: a section per
// kind, each resource, its versions, and under a version its executions or its files. What the
// chat made reads plainly; what it worked from is dimmed. A name opens the thing beside.

import { useQuery } from "@tanstack/react-query";
import { conversationsResourcesOptions } from "@texera/catalog-client/query";
import type { ChatResource, ComputingUnitStatus, ExecutionStatus } from "@texera/catalog-client/types";
import { SectionTitle, cn, timeAgo } from "@texera/ui";
import { ChevronRight, FileText } from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import { PhaseIcon } from "../execution/PhaseIcon";
import { filesQuery } from "../files/api";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { chatTree, type ExecutionNode, type ResourceNode, type SectionNode, type VersionNode } from "./chat-tree";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";

/** How many rows a list under a row shows before the rest fold into "N more". */
const SHOWN = 5;
/** How far a level is indented, in pixels. */
const INDENT = 14;

/** Which rows a person opened or closed; a row nobody touched stays as it started. */
interface Folds {
  isOpen: (row: { id: string; open: boolean }) => boolean;
  set: (id: string, open: boolean) => void;
}

/** The phases an execution leaves by itself; a paused one waits for someone, who refreshes the tree. */
const GOING = new Set<ExecutionStatus["phase"]>(["pending", "provisioning", "running"]);
const runsOn = (items: ChatResource[] | undefined) =>
  !!items?.some(
    i => i.resource.kind === "execution" && GOING.has((i.resource.status as ExecutionStatus | undefined)?.phase ?? "pending")
  );

/**
 * The chat's tree under the title "From this chat". A chat with nothing in it shows `empty`
 * under the title, or nothing at all when there is no `empty`.
 */
export const FromThisChat = memo(function FromThisChat({ rid, className, empty = null }: { rid: string; className?: string; empty?: ReactNode }) {
  const { data } = useQuery({
    ...conversationsResourcesOptions({ path: { rid } }),
    staleTime: 10_000,
    // An execution still going is watched until it ends, so its row says how it ended.
    refetchInterval: query => (runsOn(query.state.data) ? 3_000 : false),
  });
  const tree = useMemo(() => chatTree(data ?? []), [data]);
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const folds = useMemo<Folds>(
    () => ({
      isOpen: row => chosen.get(row.id) ?? row.open,
      set: (id, open) => setChosen(m => new Map(m).set(id, open)),
    }),
    [chosen]
  );
  if (!data || (!tree.length && empty === null)) return null;
  return (
    <section aria-label="From this chat" className={cn("space-y-2 text-xs", className)} data-chat-tree>
      <SectionTitle>From this chat</SectionTitle>
      {tree.length ? (
        <ul className="space-y-1">
          {tree.map(section => (
            <Section key={section.id} node={section} folds={folds} />
          ))}
        </ul>
      ) : (
        empty
      )}
    </section>
  );
});

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />;
}

function Section({ node, folds }: { node: SectionNode; folds: Folds }) {
  const open = folds.isOpen(node);
  return (
    <li data-tree-section={node.kind}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => folds.set(node.id, !open)}
        className="flex w-full items-center gap-1.5 rounded-md py-0.5 text-left font-medium text-muted-foreground hover:text-foreground">
        <span className="inline-flex size-5 shrink-0 items-center justify-center">
          <Chevron open={open} />
        </span>
        {KINDS[node.kind].plural}
        <span className="font-normal">{node.children.length}</span>
      </button>
      {open && (
        <ul>
          {node.children.map(child => (
            <ResourceRow key={child.id} node={child} folds={folds} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ResourceRow({ node, folds }: { node: ResourceNode; folds: Folds }) {
  const { beside } = useOpenResource();
  const { metadata, status } = node.resource;
  const ref: ResourceRef = {
    kind: node.kind,
    rid: metadata.rid,
    ...(metadata.parent ? { parent: metadata.parent } : {}),
  };
  const phase = node.kind === "computing-unit" ? (status as ComputingUnitStatus | undefined)?.phase : undefined;
  return (
    <Line
      depth={1}
      row={node}
      folds={folds}
      foldable={node.children.length > 0}
      icon={<KindIcon kind={node.kind} className="size-5 rounded-md [&_svg]:size-3" />}
      label={metadata.name}
      dim={!node.made}
      meta={phase}
      onOpen={() => beside(ref)}
      data={{ "data-tree-resource": node.kind, "data-made": node.made }}>
      <Limited
        id={node.id}
        folds={folds}
        depth={2}
        items={node.children}
        render={child =>
          child.type === "version" ? (
            <VersionRow key={child.id} node={child} folds={folds} />
          ) : (
            <ExecutionRow key={child.id} node={child} depth={2} />
          )
        }
      />
    </Line>
  );
}

function VersionRow({ node, folds }: { node: VersionNode; folds: Folds }) {
  const { beside } = useOpenResource();
  const { vno, made, message, createdAt } = node.version;
  const ref: ResourceRef = { kind: node.kind, rid: node.resource.metadata.rid, vno };
  return (
    <Line
      depth={2}
      row={node}
      folds={folds}
      foldable={node.files || node.children.length > 0}
      label={
        <>
          v{vno}
          {message && <span className="text-muted-foreground"> {message}</span>}
        </>
      }
      name={`v${vno}`}
      dim={!made}
      meta={timeAgo(createdAt)}
      onOpen={() => beside(ref)}
      data={{ "data-tree-version": vno, "data-made": made }}>
      {node.files ? (
        <Files node={node} folds={folds} open={() => beside(ref)} />
      ) : (
        <Limited
          id={node.id}
          folds={folds}
          depth={3}
          items={node.children}
          render={child => <ExecutionRow key={child.id} node={child} depth={3} />}
        />
      )}
    </Line>
  );
}

function ExecutionRow({ node, depth }: { node: ExecutionNode; depth: number }) {
  const { beside } = useOpenResource();
  const { metadata, status } = node.resource;
  const phase = (status as ExecutionStatus | undefined)?.phase;
  return (
    <Line
      depth={depth}
      icon={<PhaseIcon phase={phase} className="size-3.5" />}
      label={metadata.name}
      onOpen={() =>
        beside({ kind: "execution", rid: metadata.rid, ...(metadata.parent ? { parent: metadata.parent } : {}) })
      }
      data={{ "data-tree-execution": phase ?? "pending" }}
    />
  );
}

/** The files of a version, read when the version is open; each opens the version they are in. */
function Files({ node, folds, open }: { node: VersionNode; folds: Folds; open: () => void }) {
  const { data, isPending } = useQuery(filesQuery(node.kind, node.resource.metadata.rid, node.version.vno));
  if (isPending) return <Line depth={3} label="…" dim onOpen={open} />;
  return (
    <Limited
      id={node.id}
      folds={folds}
      depth={3}
      items={data?.files ?? []}
      render={file => (
        <Line
          key={file.path}
          depth={3}
          icon={<FileText className="size-3.5 shrink-0 text-muted-foreground" />}
          label={file.path}
          onOpen={open}
          data={{ "data-tree-file": file.path }}
        />
      )}
    />
  );
}

/** The first rows of a list, and the rest behind "N more". */
function Limited<T>({
  id,
  folds,
  depth,
  items,
  render,
}: {
  id: string;
  folds: Folds;
  depth: number;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  const all = folds.isOpen({ id: `${id}#all`, open: false });
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      {shown.map(render)}
      {items.length > shown.length && (
        <li style={{ paddingLeft: depth * INDENT + 26 }}>
          <button
            type="button"
            onClick={() => folds.set(`${id}#all`, true)}
            className="py-0.5 text-muted-foreground hover:text-foreground"
            data-tree-more>
            {items.length - shown.length} more
          </button>
        </li>
      )}
    </>
  );
}

/**
 * One row: a fold toggle when something is under it, its icon, its name (which opens it) and
 * a fact at the end. A dimmed row is one the chat worked from rather than made.
 */
function Line({
  depth,
  row,
  folds,
  foldable = false,
  icon,
  label,
  name,
  dim = false,
  meta,
  onOpen,
  data,
  children,
}: {
  depth: number;
  row?: { id: string; open: boolean };
  folds?: Folds;
  foldable?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  /** What the row is called, where the label is more than words. */
  name?: string;
  dim?: boolean;
  meta?: ReactNode;
  onOpen: () => void;
  data?: Record<`data-${string}`, string | number | boolean>;
  children?: ReactNode;
}) {
  const open = !!row && !!folds && folds.isOpen(row);
  const called = name ?? (typeof label === "string" ? label : "");
  return (
    <li {...data}>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 hover:bg-accent"
        style={{ paddingLeft: depth * INDENT }}>
        {foldable && row && folds ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Fold" : "Unfold"} ${called}`}
            onClick={() => folds.set(row.id, !open)}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground">
            <Chevron open={open} />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden />
        )}
        {icon}
        <button
          type="button"
          onClick={onOpen}
          data-open-row
          title={dim ? `${called}: worked from, made elsewhere` : called}
          className={cn(
            "min-w-0 flex-1 truncate text-left hover:underline",
            dim ? "text-muted-foreground" : "text-foreground"
          )}>
          {label}
        </button>
        {meta && <span className="shrink-0 text-muted-foreground">{meta}</span>}
      </div>
      {foldable && open && <ul>{children}</ul>}
    </li>
  );
}
