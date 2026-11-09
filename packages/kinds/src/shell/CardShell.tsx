import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button, Skeleton, Tooltip, cn } from "@texera/ui";
import { Check, Maximize2, PanelRight, Plus } from "lucide-react";
import { createContext, type ReactNode, use } from "react";
import { resourceQuery } from "../queries";
import { KINDS } from "../registry";
import type { KindCardProps, ResourceRef } from "../types";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";

/** What lets a person pick the cards under it: a chat, for its next message. */
export interface CardPicking {
  picked: (ref: ResourceRef) => boolean;
  toggle: (ref: ResourceRef) => void;
}

export const CardPickingContext = createContext<CardPicking | undefined>(undefined);

export interface CardSummary {
  name: string;
  facts?: string[];
}

/** The envelope of a card's resource (given or fetched) and the summary cards show. */
export function useCardSummary(ref: ResourceRef, given?: Resource) {
  const { data } = useQuery({ ...resourceQuery(ref.rid), enabled: !given });
  const resource = given ?? data;
  const facts = resource ? (KINDS[ref.kind].facts?.(resource) ?? []) : [];
  const summary: CardSummary | undefined = resource ? { name: resource.metadata.name, facts } : undefined;
  return { resource, summary };
}

/** The frame every card shares: the kind, the name, open-beside and open-page, and facts. */
export function CardShell({
  ref,
  summary,
  children,
  actions,
  className,
}: {
  ref: ResourceRef;
  summary?: CardSummary;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const spec = KINDS[ref.kind];
  const { beside, expand } = useOpenResource();
  const picking = use(CardPickingContext);
  const picked = picking?.picked(ref) === true;
  return (
    <div
      data-resource-card={ref.kind}
      data-rid={ref.rid}
      data-card-picked={picked ? "true" : undefined}
      className={cn(
        "not-prose overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs transition-shadow",
        picked && "border-primary ring-2 ring-primary/30",
        className
      )}>
      <div className="flex items-center gap-3 border-b px-3 py-2.5">
        <KindIcon kind={ref.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {spec.label}
            {ref.vno !== undefined && <span className="ml-1 normal-case">v{ref.vno}</span>}
          </div>
          {summary ? <div className="truncate text-sm font-semibold">{summary.name}</div> : <Skeleton className="mt-1 h-4 w-40" />}
        </div>
        {actions}
        {picking && (
          <Tooltip content={picked ? "Take it out of your next message" : "Add it to your next message"}>
            <Button
              variant={picked ? "default" : "ghost"}
              size="icon-sm"
              onClick={() => picking.toggle(ref)}
              aria-label={picked ? "Take it out of your next message" : "Add it to your next message"}
              aria-pressed={picked}
              data-card-pick>
              {picked ? <Check /> : <Plus />}
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Open beside">
          <Button variant="ghost" size="icon-sm" onClick={() => beside(ref)} aria-label="Open beside">
            <PanelRight />
          </Button>
        </Tooltip>
        <Tooltip content="Open full page">
          <Button variant="ghost" size="icon-sm" onClick={() => expand(ref)} aria-label="Open full page">
            <Maximize2 />
          </Button>
        </Tooltip>
      </div>
      {children}
      {!!summary?.facts?.length && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
          {summary.facts.map(f => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The card of a kind with nothing special to show: the name, the description and the facts. */
export function GenericCard({ ref, resource }: KindCardProps) {
  const { resource: r, summary } = useCardSummary(ref, resource);
  const parent = r ? { ...ref, parent: r.metadata.parent } : ref;
  return (
    <CardShell ref={parent} summary={summary}>
      {r?.metadata.description && <p className="px-3 py-2 text-sm text-muted-foreground">{r.metadata.description}</p>}
    </CardShell>
  );
}
