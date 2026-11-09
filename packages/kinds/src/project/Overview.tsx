// A project at a glance, by kind of resource, one line each: what it is, who can see it and whose
// it is. It is the project's own page and what the chat floats over before it starts work.

import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Skeleton } from "@texera/ui";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import { describe, operatorsOf } from "../library/describe";
import { operatorListQuery, resourceQuery, unitsQuery, useHoldings } from "../queries";
import { KINDS } from "../registry";
import { KindIcon } from "../shell/KindIcon";
import { useMay } from "../shell/may";
import { useOpenResource } from "../shell/navigation";
import { ResourceLabels, RowName } from "../shell/ResourceRow";
import type { KindId } from "../types";
import { pluralOf } from "../uri";

/** How many of a kind the overview shows; the rest are a click away. */
const SHOWN = 4;
const LISTED: KindId[] = ["dataset", "model", "workflow", "conversation"];

/** What a row says beside a resource's name: a unit what it has, the rest what they are. */
function rowText(r: Resource, kind: KindId): string {
  if (kind === "computing-unit") return (KINDS[kind].facts?.(r) ?? []).join(" · ");
  return describe(r);
}

/** A kind's section, the most recently changed first, as the catalog answers. */
function Section({ kind, title, items, more, moreLabel, project, editable }: { kind: KindId; title: string; items: Resource[]; more?: number; moreLabel?: string; project: string; editable: boolean }) {
  const { expand } = useOpenResource();
  const navigate = useNavigate();
  const rest = more ?? items.length - SHOWN;
  return (
    <section className="rounded-xl border bg-card" data-overview-section={kind}>
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <KindIcon kind={kind} className="size-6" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        {rest > 0 && (
          <button type="button" onClick={() => void navigate({ to: "/$plural", params: { plural: pluralOf(kind) } })} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            {moreLabel ?? `View all ${items.length}`}
          </button>
        )}
      </header>
      {/* Beside a chat the list can be narrow: what is left out then is the labels, not its right edge. */}
      <ul className="divide-y @container">
        {items.slice(0, SHOWN).map(r => {
          const open = () => expand({ kind, rid: r.metadata.rid, parent: r.metadata.parent });
          const text = rowText(r, kind);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the name in the row is the keyboard's way in
            <li key={r.metadata.rid} data-resource-row={r.kind} onClick={open} className="group/row flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-accent/50">
              <RowName resource={r} editable={editable && r.metadata.project === project} onOpen={open} />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={text}>
                {text}
              </span>
              <span className="hidden @[30rem]:block">
                <ResourceLabels metadata={r.metadata} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * What a project holds. `titled` says whether it names the project itself: the
 * project's own page has a header for that.
 */
export const ProjectOverview = memo(function ProjectOverview({ rid, titled = true }: { rid: string; titled?: boolean }) {
  const { data: project } = useQuery(resourceQuery(rid));
  const { of, isPending } = useHoldings(rid, LISTED);
  const { data: operators } = useQuery(operatorListQuery(rid));
  const { data: units } = useQuery(unitsQuery(rid));
  const may = useMay(rid);
  const { own, builtIn } = operatorsOf(operators?.items ?? [], rid);
  const sections: { kind: KindId; title: string; items: Resource[]; more?: number; moreLabel?: string }[] = [
    { kind: "dataset", title: "Data", items: of("dataset") },
    { kind: "model", title: "Models", items: of("model") },
    {
      kind: "operator",
      title: "Operators",
      items: own,
      more: builtIn.length,
      moreLabel: `${builtIn.length} built-in`,
    },
    { kind: "workflow", title: "Workflows", items: of("workflow") },
    { kind: "computing-unit", title: "Computing units", items: units ?? [] },
    { kind: "conversation", title: "Recent chats", items: of("conversation") },
  ];
  const shown = sections.filter(s => s.items.length > 0);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-6" data-project-overview={rid}>
      {titled && (
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{project?.metadata.name}</h1>
          {project?.metadata.description && (
            <p className="truncate text-sm text-muted-foreground" title={project.metadata.description}>
              {project.metadata.description}
            </p>
          )}
        </header>
      )}
      {isPending ? (
        <Skeleton className="h-64" />
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet. Ask for something below, or attach a file to start.</p>
      ) : (
        shown.map(s => <Section key={s.kind} {...s} project={rid} editable={may.write === true} />)
      )}
    </div>
  );
});
