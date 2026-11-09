// The start page's view of a project: its logo, and four cards that each roll through what the
// project holds of a kind. It shows what is there at a glance and leaves the page to the question;
// the project's own page has the whole list.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Resource } from "@texera/catalog-client/types";
import { useEffect, useState } from "react";
import { useLook } from "../branding";
import { describe } from "../library/describe";
import { searchAllQuery } from "../queries";
import { isKindId } from "../registry";
import { KindIcon } from "../shell/KindIcon";
import { useOpenResource } from "../shell/navigation";
import { OwnerTag } from "../shell/ResourceRow";
import { type KindId, kindEntry } from "../types";

/** How long a card stays on one resource. */
export const ROLL_EVERY_MS = 3600;
/** How far apart the cards roll, so that they do not all change at once. */
const STAGGER_MS = 900;

const CARDS: { kind: KindId; title: string }[] = [
  { kind: "dataset", title: "Dataset" },
  { kind: "model", title: "Model" },
  { kind: "workflow", title: "Workflow" },
  { kind: "conversation", title: "Recent chat" },
];

const stillRequested = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How many steps a card has rolled; it stands still while pointed at or when motion is unwelcome. */
function useRoll(size: number, after: number, held: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (size < 2 || held || stillRequested()) return;
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      setStep(s => s + 1);
      every = setInterval(() => setStep(s => s + 1), ROLL_EVERY_MS);
    }, after);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [size, after, held]);
  return step;
}

/** One resource on a card. */
function Face({ resource, kind, className, away }: { resource: Resource; kind: KindId; className?: string; away?: boolean }) {
  const { expand } = useOpenResource();
  const m = resource.metadata;
  const about = describe(resource);
  return (
    <button
      type="button"
      inert={away}
      onClick={() => expand({ kind: isKindId(resource.kind) ? resource.kind : kind, rid: m.rid, parent: m.parent })}
      className={`absolute inset-0 flex flex-col justify-end gap-0.5 px-4 pb-3 text-left ${className ?? ""}`}
      data-deck-face={away ? undefined : m.name}>
      <span className="truncate text-sm font-semibold">{m.name}</span>
      {about && <span className="truncate text-xs text-muted-foreground">{about}</span>}
      <OwnerTag metadata={m} className="truncate text-xs text-muted-foreground/80" />
    </button>
  );
}

function Card({ kind, title, items, after }: { kind: KindId; title: string; items: Resource[]; after: number }) {
  const navigate = useNavigate();
  const [held, setHeld] = useState(false);
  const step = useRoll(items.length, after, held);
  const size = items.length;
  const shown = size ? items[step % size] : undefined;
  const before = size > 1 && step > 0 ? items[(step - 1) % size] : undefined;
  return (
    <section
      className="flex h-36 flex-col overflow-hidden rounded-2xl border bg-card shadow-xs transition-shadow hover:shadow-md"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      aria-label={title}
      data-deck-card={kind}>
      <button
        type="button"
        onClick={() => void navigate({ to: "/$plural", params: { plural: kindEntry(kind).plural } })}
        className="flex shrink-0 items-center gap-2 px-4 pt-3 text-left"
        data-deck-all={kind}>
        <KindIcon kind={kind} className="size-6" />
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</span>
        {size > 0 && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{size}</span>}
      </button>
      <div className="relative min-h-0 flex-1 overflow-hidden hover:bg-accent/40">
        {before && <Face key={`out:${step}`} resource={before} kind={kind} className="animate-roll-out" away />}
        {shown ? (
          <Face key={`in:${step}`} resource={shown} kind={kind} className={step > 0 ? "animate-roll-in" : undefined} />
        ) : (
          <p className="absolute inset-x-4 bottom-3 text-sm text-muted-foreground">None yet</p>
        )}
      </div>
    </section>
  );
}

/** A project's logo, centred, over its four cards. */
export function ProjectDeck({ rid }: { rid: string }) {
  const look = useLook();
  // What the agent and the others add arrives while the page is open.
  const { data } = useQuery({ ...searchAllQuery({ project: rid }), refetchInterval: 5_000 });
  const held = data?.items ?? [];
  return (
    <div className="flex w-full flex-col items-center gap-6" data-project-deck={rid}>
      {look.logoLargeUrl && <img src={look.logoLargeUrl} alt={look.name} className="size-28 object-contain" data-project-logo />}
      <div className="grid w-full grid-cols-2 gap-4">
        {CARDS.map((card, i) => (
          <Card key={card.kind} {...card} items={held.filter(r => r.kind === card.kind)} after={ROLL_EVERY_MS + i * STAGGER_MS} />
        ))}
      </div>
    </div>
  );
}
