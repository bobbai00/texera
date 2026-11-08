// The resource graph beside a chat: what the chat read, made and ran, and how it connects. Data,
// computation and results stand left to right. In the computation a workflow's card stands
// beside its runs, each run a box in the lane of the unit it ran on, the unit at the lane's foot;
// dotted ties join a run to both. Only data flows are arrows. It zooms in three levels, each
// showing more: the whole graph by name, each thing with its facts, and each workflow's steps
// with the file and the table each step read or made. A click goes into a thing: the graph gives
// way to its view, and the person goes back the way they came (ResourcePanel keeps the trail).
// The outside sources the agent consulted sit above.

import { useQuery } from "@tanstack/react-query";
import { conversationsGraphOptions } from "@texera/catalog-client/query";
import type { ConversationGraph, GraphSource } from "@texera/catalog-client/types";
import { Button, cn } from "@texera/ui";
import { Info, Minus, Plus, Scan } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { KindIcon } from "../shell/KindIcon";
import { type Box, type Layout, layOut, type Measured } from "./layout";
import { type GraphView, type Level, SOMEWHERE, touching, viewOf } from "./model";
import { DataCard, type Handlers, RerunNote, ResultTile, RunBox, UnitFoot, WorkCard } from "./parts";
import { lineOf } from "./steps";

/** Each level: its type size against the standard one, and the zoom it opens at. */
const LEVELS: { id: Level; label: string; u: number; home: number }[] = [
  { id: "overview", label: "Overview", u: 1.3, home: 0.6 },
  { id: "standard", label: "Standard", u: 1, home: 1 },
  { id: "detail", label: "Detail", u: 0.62, home: 1.55 },
];
/** The drawing's type at the standard level, in pixels at zoom 1. */
const BASE = 12.5;
const K_MIN = 0.42;
const K_MAX = 2.6;
/** The zooms where the next level begins. */
const T1 = 0.75;
const T2 = 1.3;
export const levelOf = (k: number): Level => (k < T1 ? "overview" : k < T2 ? "standard" : "detail");
const levelSpec = (l: Level) => LEVELS.find(x => x.id === l) ?? (LEVELS[1] as (typeof LEVELS)[number]);
/** How wide a graph with all three columns is at each level, in its ems: what a young graph is framed for. */
const WIDE: Record<Level, number> = { overview: 54, standard: 62, detail: 66 };

const GOING = new Set(["pending", "provisioning", "running"]);

/** The graph of a chat, and whether the chat has started work: made something, or planned to. */
export function useChatGraph(
  rid: string,
  { enabled = true, live = false }: { enabled?: boolean; live?: boolean } = {}
) {
  const query = useQuery({
    ...conversationsGraphOptions({ path: { rid } }),
    enabled,
    staleTime: 2_000,
    // While the agent works or a run goes, the graph follows it closely; else now and then, for
    // what others in the chat make.
    refetchInterval: q => (live || q.state.data?.nodes.some(n => GOING.has(n.state ?? "")) ? 2_500 : 10_000),
  });
  const graph = query.data;
  const started = !!graph && (graph.planned.length > 0 || graph.nodes.some(n => n.made));
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  return { graph, started, refresh };
}

/** A short fingerprint of what the catalog said, so a layout is redone only when it changes. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
}

/** How far down an element sits inside another it is drawn in. */
function offsetWithin(el: HTMLElement, root: HTMLElement): number {
  let y = 0;
  let at: HTMLElement | null = el;
  while (at && at !== root) {
    y += at.offsetTop;
    at = at.offsetParent as HTMLElement | null;
  }
  return y;
}

const boxOf = (layout: Layout, id: string): Box | undefined =>
  layout.places.get(id) ?? layout.lanes.find(l => l.unit === id)?.foot;

/** The drawn thing nearest a point of the drawing. */
function nearest(layout: Layout, x: number, y: number): string | undefined {
  let best: string | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const [id, b] of layout.places) {
    const d = (b.x + b.w / 2 - x) ** 2 + (b.y + b.h / 2 - y) ** 2;
    if (d < distance) {
      distance = d;
      best = id;
    }
  }
  return best;
}

export function ResourceGraph({
  graph,
  className,
  bar,
  onOpen,
  inert,
}: {
  rid: string;
  graph: ConversationGraph;
  className?: string;
  bar?: ReactNode;
  /** Goes into a thing on the graph, from the element drawn for it. */
  onOpen?: (id: string, from: HTMLElement, view: GraphView) => void;
  /** Something stands over the graph: it takes no focus and no pointer. */
  inert?: boolean;
}) {
  const view = useMemo(() => viewOf(graph), [graph]);
  const said = useMemo(() => fingerprint(graph), [graph]);
  const [cam, setCam] = useState({ k: 1, tx: 24, ty: 16 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const level = levelOf(cam.k);
  const em = BASE * levelSpec(level).u;
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<{ key: string; layout: Layout }>();
  const laidRef = useRef(laid);
  laidRef.current = laid;
  // What the camera does once the next layout is known: frame everything, or keep a thing where it is on screen.
  const pending = useRef<{ fit?: boolean; anchor?: { id: string; sx: number; sy: number } }>({ fit: true });
  const [tick, setTick] = useState(0);
  const key = `${level}|${said}`;
  const [hover, setHover] = useState<string>();
  const [legend, setLegend] = useState(false);

  // Measure what is drawn at this level, lay it out, and point the camera.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names everything a layout depends on; tick asks for a new one
  useLayoutEffect(() => {
    const root = world.current;
    if (!root) return;
    const els = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-graph-measure]"))
      els.set(el.dataset.graphMeasure as string, el);
    const measured: Measured = {
      size: id => {
        const el = els.get(id);
        return el ? { w: el.offsetWidth, h: el.offsetHeight } : undefined;
      },
      row: (id, row) => {
        const el = els.get(id);
        const r = el?.querySelector<HTMLElement>(`[data-graph-row="${CSS.escape(row)}"]`);
        return el && r ? offsetWithin(r, el) + r.offsetHeight / 2 : undefined;
      },
    };
    const layout = layOut(view, measured, level, em);
    setLaid({ key, layout });
    const vp = viewport.current;
    const p = pending.current;
    if (!vp) return;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    if (p.fit) {
      if (W < 40 || H < 40) return;
      // A graph that has not grown its three columns yet is framed as if it had them, so what
      // comes later has room and nothing moves when it does.
      const wide = Math.max(layout.width, WIDE[level] * em);
      const fits = Math.min((W - 28) / wide, (H - 48) / Math.max(layout.height, 1));
      if (level !== "overview" && fits < T1) {
        setCam(c => ({ ...c, k: levelSpec("overview").home }));
        return;
      }
      const k = level === "overview" ? Math.min(Math.max(fits, K_MIN), T1 - 0.01) : Math.min(Math.max(fits, T1), 1.12);
      pending.current = {};
      setCam({ k, tx: Math.max(14, (W - wide * k) / 2), ty: 16 });
      return;
    }
    if (p.anchor) {
      const { id, sx, sy } = p.anchor;
      const b = boxOf(layout, id);
      pending.current = {};
      if (b) setCam(c => ({ ...c, tx: sx - (b.x + b.w / 2) * c.k, ty: sy - (b.y + b.h / 2) * c.k }));
    }
  }, [key, tick]);

  // A panel first measured at no size frames the graph once it has one.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const watch = new ResizeObserver(() => {
      if (pending.current.fit && vp.clientWidth >= 40) setTick(t => t + 1);
    });
    watch.observe(vp);
    return () => watch.disconnect();
  }, []);

  /** Zooms to k about a point of the viewport; a new level keeps the thing nearest it in place. */
  const zoomAt = useCallback((next: number, sx: number, sy: number) => {
    const c = camRef.current;
    const k = Math.min(K_MAX, Math.max(K_MIN, next));
    const wx = (sx - c.tx) / c.k;
    const wy = (sy - c.ty) / c.k;
    const layout = laidRef.current?.layout;
    if (levelOf(k) !== levelOf(c.k) && layout) {
      const id = nearest(layout, wx, wy);
      const b = id ? boxOf(layout, id) : undefined;
      if (id && b)
        pending.current = { anchor: { id, sx: (b.x + b.w / 2) * c.k + c.tx, sy: (b.y + b.h / 2) * c.k + c.ty } };
    }
    setCam({ k, tx: sx - wx * k, ty: sy - wy * k });
  }, []);

  const centre = () => ({ x: (viewport.current?.clientWidth ?? 0) / 2, y: (viewport.current?.clientHeight ?? 0) / 2 });
  const frameAll = () => {
    pending.current = { fit: true };
    setCam(c => ({ ...c, k: 1 }));
    setTick(t => t + 1);
  };
  const toLevel = (l: Level) => {
    const layout = laidRef.current?.layout;
    const c = camRef.current;
    const { x, y } = centre();
    const target = layout ? nearest(layout, (x - c.tx) / c.k, (y - c.ty) / c.k) : undefined;
    if (l === level) {
      const b = layout && target ? boxOf(layout, target) : undefined;
      if (b) setCam({ ...c, tx: x - (b.x + b.w / 2) * c.k, ty: y - (b.y + b.h / 2) * c.k });
      return;
    }
    pending.current = target ? { anchor: { id: target, sx: x, sy: y } } : {};
    setCam({ ...c, k: levelSpec(l).home });
  };

  // A wheel moves the graph; with Ctrl or ⌘, or a pinch, it zooms.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(
          camRef.current.k * Math.exp(-e.deltaY * (Math.abs(e.deltaY) > 40 ? 0.002 : 0.012)),
          e.clientX - r.left,
          e.clientY - r.top
        );
      else setCam(c => ({ ...c, tx: c.tx - e.deltaX, ty: c.ty - e.deltaY }));
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // A drag moves the graph; two fingers pinch it.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    moved: boolean;
    pinch?: { d: number; k: number };
  }>(undefined);
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const c = camRef.current;
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      drag.current = {
        x: 0,
        y: 0,
        tx: c.tx,
        ty: c.ty,
        moved: true,
        pinch: { d: Math.hypot(p.x - q.x, p.y - q.y), k: c.k },
      };
    } else drag.current = { x: e.clientX, y: e.clientY, tx: c.tx, ty: c.ty, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.pinch && pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const r = viewport.current?.getBoundingClientRect();
      zoomAt(
        d.pinch.k * (Math.hypot(p.x - q.x, p.y - q.y) / d.pinch.d),
        (p.x + q.x) / 2 - (r?.left ?? 0),
        (p.y + q.y) / 2 - (r?.top ?? 0)
      );
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      viewport.current?.setPointerCapture(e.pointerId);
    }
    setCam(c => ({ ...c, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0 && drag.current && !drag.current.moved) drag.current = undefined;
  };

  const handlers: Handlers = {
    onOpen: (id, from) => {
      setHover(undefined);
      onOpen?.(id, from, view);
    },
    onHover: setHover,
  };
  const near = useMemo(() => (hover ? touching(view, hover) : undefined), [view, hover]);
  const layout = laid?.key === key ? laid.layout : undefined;
  const place = (id: string, stretch = false): React.CSSProperties => {
    const b = layout?.places.get(id);
    return b ? { left: b.x, top: b.y, ...(stretch ? { height: b.h } : {}) } : { left: 0, top: 0, visibility: "hidden" };
  };
  const dim = (id: string) => near && !near.has(id) && "opacity-25";
  const lit = (ends: string[]) => !!near && ends.every(e => near.has(e));
  const boxes = [...view.runs.values()];
  const madeBy = (id: string) => boxes.find(b => b.results.includes(id));
  const opOf = (id: string) => {
    const n = view.nodes.get(id);
    const box = madeBy(id);
    const step = view.works.find(w => w.id === box?.work)?.steps.find(s => s.id === n?.step);
    return step ? lineOf(step, view.nodes).op : undefined;
  };
  const unitName = (id: string) =>
    id === SOMEWHERE ? undefined : (view.units.get(id)?.node?.name ?? view.units.get(id)?.planned?.name);
  const feet = [...new Set([...boxes.map(b => b.unit), ...view.idle])];

  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)} data-resource-graph inert={inert}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
        {bar}
        <div className="ml-auto flex items-center gap-1">
          <fieldset className="m-0 inline-flex rounded-lg border bg-muted/60 p-0.5" aria-label="How close">
            {LEVELS.map(l => (
              <button
                key={l.id}
                type="button"
                aria-pressed={level === l.id}
                onClick={() => toLevel(l.id)}
                className={cn(
                  "rounded-md px-1.5 py-1 text-xs",
                  level === l.id
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
                data-graph-level={l.id}>
                {l.label}
              </button>
            ))}
          </fieldset>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => zoomAt(cam.k / 1.3, centre().x, centre().y)}>
            <Minus />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => zoomAt(cam.k * 1.3, centre().x, centre().y)}>
            <Plus />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Fit everything"
            title="Fit everything"
            onClick={frameAll}
            data-graph-fit>
            <Scan />
          </Button>
          <Button
            variant={legend ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="What the shapes mean"
            aria-pressed={legend}
            onClick={() => setLegend(v => !v)}>
            <Info />
          </Button>
        </div>
      </div>
      {graph.sources.length > 0 && <Consulted sources={graph.sources} />}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={viewport}
          className="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden outline-none select-none active:cursor-grabbing"
          role="application"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the graph takes keys to zoom and move, so it takes focus
          tabIndex={0}
          aria-label="What this chat read, made and ran. Plus and minus zoom, 0 fits, the arrows move; Enter on a thing goes into it."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClickCapture={e => {
            if (drag.current?.moved) {
              e.stopPropagation();
              drag.current = undefined;
            }
          }}
          onKeyDown={e => {
            const { x, y } = centre();
            if (e.key === "+" || e.key === "=") zoomAt(cam.k * 1.25, x, y);
            else if (e.key === "-" || e.key === "_") zoomAt(cam.k / 1.25, x, y);
            else if (e.key === "0") frameAll();
            else if (e.key.startsWith("Arrow")) {
              const step = 48;
              setCam(c => ({
                ...c,
                tx: c.tx + (e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0),
                ty: c.ty + (e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0),
              }));
            } else return;
            e.preventDefault();
          }}>
          <div
            ref={world}
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.k})`, fontSize: `${em}px` }}
            data-graph-zoom={level}>
            {layout?.columns.map(c => (
              <div
                key={c.rank}
                className="absolute top-0 flex items-baseline gap-[0.5em] text-[0.78em] font-semibold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase"
                style={{ left: c.x }}
                data-graph-column={c.label.toLowerCase()}>
                {c.label}
                <span className="font-normal tracking-normal text-muted-foreground/70">{c.count || ""}</span>
              </div>
            ))}
            {/* Each unit's lane, faint behind its runs, down to the unit at its foot. */}
            {layout?.lanes.map(l => (
              <div
                key={`${l.rank}|${l.unit}`}
                className={cn(
                  "absolute rounded-[1.2em] transition-opacity",
                  l.unit === SOMEWHERE ? "bg-muted/40" : "bg-kind-computing-unit/[0.05]",
                  dim(l.unit)
                )}
                style={{
                  left: l.foot.x - 0.6 * em,
                  width: l.foot.w + 1.2 * em,
                  top: l.top - 1.9 * em,
                  height: l.foot.y + l.foot.h + 0.6 * em - (l.top - 1.9 * em),
                }}
                data-graph-lane={l.unit}
                aria-hidden
              />
            ))}
            {layout && (
              <svg
                className="pointer-events-none absolute top-0 left-0 overflow-visible"
                width={Math.ceil(layout.width + 8)}
                height={Math.ceil(layout.height + 8)}
                aria-hidden>
                {layout.ties.map(t => {
                  const hot = lit(t.ends);
                  return (
                    <g
                      key={t.key}
                      data-graph-tie={t.kind}
                      data-graph-ends={t.ends.join(" ")}
                      className={cn("transition-opacity", near && !hot && "opacity-20")}>
                      <path
                        d={t.path}
                        fill="none"
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray="0.1 4.5"
                        strokeLinecap="round"
                        className={hot ? "stroke-foreground" : "stroke-muted-foreground/80"}
                        strokeWidth={hot ? 2.2 : 1.8}
                      />
                    </g>
                  );
                })}
                {layout.arrows.map(a => {
                  const hot = lit([a.from, a.to]);
                  return (
                    <g
                      key={a.key}
                      data-graph-edge={a.relation}
                      className={cn("transition-opacity", near && !hot && "opacity-15")}>
                      <path
                        d={a.path}
                        fill="none"
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray={a.planned ? "5 4" : undefined}
                        className={hot ? "stroke-foreground" : "stroke-muted-foreground/70"}
                        strokeWidth={hot ? 2 : 1.5}
                      />
                      <polygon points={a.tip} className={hot ? "fill-foreground" : "fill-muted-foreground/70"} />
                      {a.label && (
                        <text
                          x={a.label.x}
                          y={a.label.y}
                          textAnchor={a.label.anchor}
                          className="fill-muted-foreground"
                          style={{
                            fontSize: "0.76em",
                            paintOrder: "stroke",
                            stroke: "var(--background)",
                            strokeWidth: "0.32em",
                            strokeLinejoin: "round",
                          }}>
                          {a.label.text}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}
            {view.works.map(w => (
              <WorkCard
                key={w.id}
                work={w}
                results={w.runs.flatMap(id => view.runs.get(id)?.results ?? [])}
                level={level}
                nodes={view.nodes}
                hot={hover}
                h={handlers}
                className={cn("transition-opacity", dim(w.id))}
                style={place(w.id)}
              />
            ))}
            {boxes.map(b => (
              <RunBox
                key={b.id}
                box={b}
                unitName={unitName(b.unit)}
                level={level}
                h={handlers}
                className={cn("transition-opacity", dim(b.id))}
                style={place(b.id, level === "detail")}
              />
            ))}
            {level !== "detail" &&
              boxes.map(b => {
                const p = layout?.places.get(b.id);
                return p ? (
                  <RerunNote key={`rerun:${b.id}`} box={b} style={{ left: p.x + p.w / 2, top: p.y + p.h + 0.3 * em }} />
                ) : null;
              })}
            {[...view.data.values()].map(d =>
              d.node?.kind === "execution" ? (
                <ResultTile
                  key={d.id}
                  node={d.node}
                  of={madeBy(d.id)?.work}
                  op={opOf(d.id)}
                  level={level}
                  h={handlers}
                  className={cn("transition-opacity", dim(d.id))}
                  style={place(d.id)}
                />
              ) : (
                <DataCard
                  key={d.id}
                  item={d}
                  level={level}
                  result={(view.rank.get(d.id) ?? 0) > 0}
                  h={handlers}
                  className={cn("transition-opacity", dim(d.id))}
                  style={place(d.id)}
                />
              )
            )}
            {layout?.lanes.map(l => (
              <UnitFoot
                key={`foot:${l.rank}|${l.unit}`}
                id={l.unit}
                unit={view.units.get(l.unit)}
                level={level}
                h={handlers}
                className={cn("transition-opacity", dim(l.unit))}
                style={{ left: l.foot.x, top: l.foot.y }}
              />
            ))}
            {/* Each unit's foot, measured where nothing shows it, for its lane's width. */}
            <div className="invisible absolute top-0 left-0" aria-hidden>
              {feet.map(id => (
                <UnitFoot key={id} id={id} unit={view.units.get(id)} level={level} measure />
              ))}
            </div>
          </div>
          <p className="pointer-events-none absolute bottom-2 left-3 rounded-md bg-background/85 px-2 py-0.5 text-2xs text-muted-foreground">
            Drag to move · Ctrl+scroll to zoom · click a box to go into it
          </p>
          {legend && <Legend />}
        </div>
      </div>
    </div>
  );
}

/** What the shapes and marks mean. */
function Legend() {
  const row = (shape: ReactNode, words: string) => (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2.5">
      <div className="flex h-5 items-center">{shape}</div>
      <span>{words}</span>
    </div>
  );
  return (
    <div
      className="absolute top-2.5 right-2.5 z-10 grid w-64 gap-2 rounded-xl border bg-card p-3 text-xs shadow-lg"
      data-graph-legend>
      {row(<span className="h-4 w-12 rounded-full border border-kind-dataset/45 bg-card" />, "Dataset")}
      {row(
        <span className="h-5 w-12 rounded-md border border-kind-workflow/55 bg-card" />,
        "Workflow, with the models and functions it uses"
      )}
      {row(
        <span className="h-4 w-11 rounded-full border border-kind-execution/60 bg-kind-execution/10" />,
        "Run: its workflow on one unit (×3, three runs)"
      )}
      {row(
        <span className="h-4 w-12 rounded-t-md rounded-b-sm border border-b-[3px] border-kind-computing-unit/45 bg-kind-computing-unit/10" />,
        "Computing unit, under the runs on it"
      )}
      {row(<span className="h-4 w-9 rounded border bg-card" />, "Table a run made")}
      {row(
        <span className="relative h-px w-11 bg-muted-foreground/70 after:absolute after:-top-1 after:-right-0.5 after:border-y-4 after:border-l-[7px] after:border-y-transparent after:border-l-muted-foreground/70" />,
        "Data read or made"
      )}
      {row(
        <span className="h-0 w-11 border-t-2 border-dotted border-muted-foreground/80" />,
        "A run's workflow and unit"
      )}
      {row(
        <span className="h-4 w-12 rounded-md border border-dashed border-muted-foreground/60" />,
        "Planned, not made yet"
      )}
      {row(<span className="ml-1 size-2.5 rounded-full bg-primary" />, "Made in this chat")}
    </div>
  );
}

/** The outside sources the agent consulted, each with its calls; a click lists what it asked. */
function Consulted({ sources }: { sources: GraphSource[] }) {
  const [open, setOpen] = useState<string>();
  const shown = sources.find(s => s.uri === open);
  return (
    <div className="shrink-0 border-b px-3 py-1.5 text-xs" data-graph-sources>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">Consulted:</span>
        {sources.map(s => (
          <button
            key={s.uri}
            type="button"
            aria-expanded={open === s.uri}
            onClick={() => setOpen(open === s.uri ? undefined : s.uri)}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted",
              open === s.uri && "bg-muted"
            )}
            data-graph-source={s.name}>
            <KindIcon kind="mcp-server" className="size-4 rounded-sm [&_svg]:size-3" />
            <span className="font-medium">{s.name}</span>
            <span className="text-muted-foreground">
              {s.calls.length} call{s.calls.length === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>
      {shown && (
        <ol className="mt-1 max-h-40 space-y-0.5 overflow-y-auto" data-graph-calls>
          {shown.calls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a call is its place in the chat
            <li key={i} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-2xs leading-4 text-muted-foreground">{c.tool}</span>
              <span className="truncate" title={c.asked}>
                {c.asked}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
