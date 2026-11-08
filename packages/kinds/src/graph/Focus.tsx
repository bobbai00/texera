// What the graph beside a chat shows when a person goes into a thing on it: the thing's own view,
// over the graph, with the trail of how they got there. A dataset, a workflow, a model, a
// function and a unit show the view they have everywhere; a run box its runs, one at a time; a
// table the rows its run kept; what the plan has not made yet what the plan said. Under the trail,
// what the thing is to the rest of the graph, to go to next. Going in grows the view out of the
// thing's box; going all the way back shrinks it into the box again. The chat beside it is never
// touched.

import { useQuery } from "@tanstack/react-query";
import { Button, cn, Skeleton, timeAgo } from "@texera/ui";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { executionQuery } from "../execution/queries";
import { resourceQuery } from "../queries";
import { ResourceView } from "../ResourceView";
import { type ResultLabel, ResultsWindow } from "../results/ResultsWindow";
import { ProjectScope } from "../scope";
import { KindIcon } from "../shell/KindIcon";
import { OpenError } from "../shell/OpenError";
import type { KindId } from "../types";
import { parseUri, refOf } from "../uri";
import { createCanvasView, portKey } from "../workflow/canvas-view";
import { entryFor, type FocusEntry, keyOf } from "./focus";
import { type GraphView, nameOf, type RunItem, relationsOf, runStateOf, SOMEWHERE } from "./model";
import { lineOf } from "./steps";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where an element stands inside another, in pixels. */
export function rectWithin(el: Element, root: Element): Rect {
  const a = el.getBoundingClientRect();
  const b = root.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
}

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const clipTo = (r: Rect, W: number, H: number) =>
  `inset(${Math.max(0, r.y)}px ${Math.max(0, W - r.x - r.w)}px ${Math.max(0, H - r.y - r.h)}px ${Math.max(0, r.x)}px round 12px)`;
const WHOLE = "inset(0px 0px 0px 0px round 0px)";

export function FocusLayer({
  trail,
  view,
  root,
  from,
  onTo,
  onGo,
  onClose,
  render = entry => <EntryView entry={entry} view={view} onGo={onGo} />,
}: {
  /** What the person went into, in order; never empty. */
  trail: FocusEntry[];
  view: GraphView;
  /** What stands under it all: the graph, or the list. */
  root: string;
  /** The box the first entry was opened from, in the layer's parent: it grows out of it. */
  from?: Rect;
  /** Goes back to the entry at this place on the trail. */
  onTo: (index: number) => void;
  /** Goes on to another entry. */
  onGo: (entry: FocusEntry) => void;
  /** Puts the layer away: the graph again. */
  onClose: () => void;
  /** What an entry shows: its view. */
  render?: (entry: FocusEntry) => ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const top = trail.at(-1) as FocusEntry;
  const leaving = useRef(false);

  // It grows out of the box it was opened from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as it opens
  useLayoutEffect(() => {
    backButton.current?.focus({ preventScroll: true });
    const el = layer.current;
    const parent = el?.parentElement;
    if (!el || !parent || reducedMotion() || typeof el.animate !== "function") return;
    if (from)
      el.animate(
        [
          { clipPath: clipTo(from, parent.clientWidth, parent.clientHeight), opacity: 0.6 },
          { clipPath: WHOLE, opacity: 1 },
        ],
        {
          duration: 260,
          easing: "cubic-bezier(.2,.75,.25,1)",
        }
      );
    else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, []);

  /** All the way back: it shrinks into the box it came from, and the graph is there again. */
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    const el = layer.current;
    const parent = el?.parentElement;
    const id = trail[0]?.id;
    const node = id && parent ? parent.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(id)}"]`) : null;
    const done = () => {
      onClose();
      requestAnimationFrame(() => node?.focus({ preventScroll: true }));
    };
    if (!el || !parent || reducedMotion() || typeof el.animate !== "function") return done();
    const to = node ? rectWithin(node, parent) : undefined;
    const shrink = el.animate(
      to
        ? [
            { clipPath: WHOLE, opacity: 1 },
            { clipPath: clipTo(to, parent.clientWidth, parent.clientHeight), opacity: 0.35 },
          ]
        : [{ opacity: 1 }, { opacity: 0 }],
      { duration: 220, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" }
    );
    shrink.onfinish = done;
  };
  const back = () => (trail.length > 1 ? onTo(trail.length - 2) : leave());
  const backRef = useRef(back);
  backRef.current = back;
  // Escape and Alt+Left go back, from the trail or from nowhere in particular; inside a view they
  // are the view's (an editor's Escape, a text field's Alt+Left).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Node | null;
      const here = !t || t === document.body || (!!layer.current?.contains(t) && !content.current?.contains(t));
      if (here && !e.defaultPrevented && (e.key === "Escape" || (e.altKey && e.key === "ArrowLeft"))) {
        e.preventDefault();
        backRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Each step along the trail leaves the keys on Back, so the way back is one key away.
  const topKey = keyOf(top);
  useEffect(() => {
    if (topKey) backButton.current?.focus({ preventScroll: true });
  }, [topKey]);
  const related = top.id ? relationsOf(view, top.id) : [];

  return (
    <div
      ref={layer}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background"
      data-graph-focus={keyOf(top)}
      data-graph-focus-kind={top.kind}>
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button ref={backButton} variant="ghost" size="sm" onClick={back} data-graph-back aria-label="Back">
          <ArrowLeft /> Back
        </Button>
        <nav
          aria-label="Where you are"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs"
          data-graph-crumbs>
          <button
            type="button"
            onClick={leave}
            className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-graph-crumb="root">
            {root}
          </button>
          {trail.map((e, i) => (
            <Fragment key={keyOf(e)}>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              <button
                type="button"
                onClick={() => onTo(i)}
                aria-current={i === trail.length - 1 ? "page" : undefined}
                className={cn(
                  "min-w-0 truncate rounded px-1.5 py-0.5 hover:bg-muted",
                  i === trail.length - 1 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                data-graph-crumb={i}>
                <EntryName entry={e} />
              </button>
            </Fragment>
          ))}
        </nav>
      </div>
      {related.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-1.5 text-xs"
          data-graph-related>
          {related.map(group => (
            <span key={group.label} className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="text-muted-foreground">{group.label}</span>
              {group.ids.map(id => {
                const entry = entryFor(view, id);
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!entry}
                    onClick={() => entry && onGo(entry)}
                    className="flex max-w-56 items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 hover:bg-muted disabled:opacity-60"
                    data-graph-go={id}>
                    <KindIcon kind={kindOf(view, id)} className="size-4 shrink-0 rounded-sm [&_svg]:size-3" />
                    <span className="truncate">{nameOf(view, id)}</span>
                  </button>
                );
              })}
            </span>
          ))}
        </div>
      )}
      <div ref={content} className="relative flex min-h-0 flex-1 flex-col overflow-hidden" key={keyOf(top)}>
        {render(top)}
      </div>
    </div>
  );
}

/** The kind of a thing on the graph, for its icon. */
function kindOf(view: GraphView, id: string): KindId {
  if (view.runs.has(id)) return "execution";
  const n = view.nodes.get(id);
  // A table a run made is data, drawn as data is.
  if (n) return n.role === "data" ? "dataset" : (n.kind as KindId);
  const planned =
    view.works.find(w => w.id === id)?.planned ?? view.data.get(id)?.planned ?? view.units.get(id)?.planned;
  const k = planned?.kind;
  return k === "workflow" || k === "dataset" || k === "computing-unit" || k === "model" || k === "operator"
    ? k
    : "dataset";
}

/** An entry's name on the trail: what the graph calls it, or the resource's own name. */
function EntryName({ entry }: { entry: FocusEntry }) {
  const rid = entry.kind === "resource" && !entry.title ? entry.ref.rid : "";
  const { data } = useQuery({ ...resourceQuery(rid), enabled: !!rid });
  return <>{entry.title ?? data?.metadata.name ?? "…"}</>;
}

/** The view an entry shows. */
export function EntryView({
  entry,
  view,
  onGo,
}: {
  entry: FocusEntry;
  view: GraphView;
  onGo: (e: FocusEntry) => void;
}) {
  if (entry.kind === "resource")
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-graph-view={entry.ref.kind}>
        <ResourceView ref={entry.ref} mode="panel" />
      </div>
    );
  if (entry.kind === "run") {
    const box = view.runs.get(entry.id);
    return box ? <RunFocus box={box} view={view} onGo={onGo} /> : <Gone />;
  }
  if (entry.kind === "table")
    return view.nodes.has(entry.id) ? <TableFocus id={entry.id} view={view} onGo={onGo} /> : <Gone />;
  return <PlannedFocus id={entry.id} view={view} />;
}

/** What is no longer on the graph. */
function Gone() {
  return <p className="m-6 text-sm text-muted-foreground">This is no longer on the graph.</p>;
}

/** A run box: its runs, newest first, one at a time in the run's own view; or the run it has not had. */
function RunFocus({ box, view, onGo }: { box: RunItem; view: GraphView; onGo: (e: FocusEntry) => void }) {
  const [pick, setPick] = useState<string>();
  const chosen = box.runs.find(r => r.uri === pick) ?? box.runs[0];
  const ref = chosen ? refOf(chosen.uri) : undefined;
  if (!chosen || !ref) return <WaitingRun box={box} view={view} onGo={onGo} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-graph-view="run">
      {box.runs.length > 1 && (
        <div
          role="tablist"
          aria-label="Its runs on this unit"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5"
          data-graph-run-list>
          {box.runs.map((r, i) => (
            <button
              key={r.uri}
              type="button"
              role="tab"
              aria-selected={r === chosen}
              onClick={() => setPick(r.uri)}
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-xs whitespace-nowrap",
                r === chosen ? "bg-accent font-medium" : "text-muted-foreground hover:bg-muted"
              )}
              data-graph-run={r.uri}>
              Run {box.runs.length - i} · {r.phase}
              {r.startedAt ? ` · ${timeAgo(r.startedAt)}` : ""}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceView key={chosen.uri} ref={{ ...ref, kind: "execution" }} mode="panel" />
      </div>
    </div>
  );
}

/** The run a workflow has not had yet: where it will run, and what the plan says of it. */
function WaitingRun({ box, view, onGo }: { box: RunItem; view: GraphView; onGo: (e: FocusEntry) => void }) {
  const state = runStateOf(box);
  const work = entryFor(view, box.work);
  const unit = box.unit === SOMEWHERE ? undefined : entryFor(view, box.unit);
  return (
    <div className="m-6 grid max-w-lg gap-3 text-sm" data-graph-view="run" data-graph-waiting={state}>
      <h3 className="text-base font-semibold">{state === "planned" ? "A planned run" : "Not run yet"}</h3>
      <p className="text-muted-foreground">
        {nameOf(view, box.work)} has not run{unit ? ` on ${nameOf(view, box.unit)}` : ""} in this chat
        {state === "planned" ? "; the plan says it will." : "."}
      </p>
      {box.planned?.detail && <p className="rounded-md border border-dashed px-3 py-2">{box.planned.detail}</p>}
      <div className="flex flex-wrap gap-2">
        {work && (
          <Button variant="outline" size="sm" onClick={() => onGo(work)}>
            The workflow
          </Button>
        )}
        {unit && (
          <Button variant="outline" size="sm" onClick={() => onGo(unit)}>
            The unit
          </Button>
        )}
      </div>
    </div>
  );
}

/** A table a run made: the rows it kept, in the results window standing on its own. */
function TableFocus({ id, view, onGo }: { id: string; view: GraphView; onGo: (e: FocusEntry) => void }) {
  const parsed = parseUri(id);
  const [, operator = "", , port = ""] = (parsed?.subresource ?? "").split("/");
  const eid = parsed?.ref.rid ?? "";
  const { data: x, error } = useQuery(executionQuery(eid));
  const canvas = useMemo(() => {
    const v = createCanvasView();
    v.getState().show(portKey(operator, port));
    return v;
  }, [operator, port]);
  const box = [...view.runs.values()].find(b => b.results.includes(id));
  const steps = view.works.find(w => w.id === box?.work)?.steps ?? [];
  const labelOf = (operatorID: string): ResultLabel => {
    const step = steps.find(s => s.id === operatorID);
    return { title: operatorID, summary: step ? lineOf(step, view.nodes).text : undefined, type: step?.type };
  };
  const run = box ? entryFor(view, box.id) : undefined;
  if (error) return <OpenError error={error} kind="execution" />;
  if (!x) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-graph-view="table">
      <ProjectScope project={x.metadata.project}>
        <ResultsWindow
          execution={x}
          workflow={x.metadata.parent ?? parsed?.ref.parent ?? ""}
          view={canvas}
          labelOf={labelOf}
          floating={false}
          onOpen={run ? () => onGo(run) : undefined}
        />
      </ProjectScope>
    </div>
  );
}

/** Something the plan said it would make and has not: what the plan said. */
function PlannedFocus({ id, view }: { id: string; view: GraphView }) {
  const item =
    view.works.find(w => w.id === id)?.planned ??
    view.data.get(id)?.planned ??
    view.units.get(id)?.planned ??
    [...view.runs.values()].find(b => b.id === id)?.planned;
  if (!item)
    return (
      <p className="m-6 text-sm text-muted-foreground">This has been made since; go back to see it on the graph.</p>
    );
  const what: Record<string, string> = {
    workflow: "a workflow",
    dataset: "a dataset",
    "computing-unit": "a computing unit",
    model: "a model",
    operator: "a function",
    execution: "a run",
  };
  return (
    <div className="m-6 grid max-w-lg gap-3 text-sm" data-graph-view="planned">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Planned, not made yet</p>
      <h3 className="text-base font-semibold">{item.name}</h3>
      <p className="text-muted-foreground">
        The chat's plan said it would make {what[item.kind ?? ""] ?? "this"}; nothing of it is made yet.
      </p>
      {item.detail && <p className="rounded-md border border-dashed px-3 py-2">{item.detail}</p>}
    </div>
  );
}
