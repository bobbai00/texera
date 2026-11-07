// The resource graph beside a chat: what the chat read, made and ran, and how they connect. It
// shares nothing visible with the workflow canvas: round icons by kind with the name beneath,
// straight labelled arrows, columns of dependency on a plain ground with bands, Used first and
// Made last. A click on a node shows what it is; Open opens it beside. It changes nothing.

import { useQuery } from "@tanstack/react-query";
import { conversationsGraphOptions } from "@texera/catalog-client/query";
import type { ConversationGraph, GraphNode, GraphRun } from "@texera/catalog-client/types";
import { Button, cn, formatDuration, timeAgo } from "@texera/ui";
import { ArrowUpRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhaseIcon } from "../execution/PhaseIcon";
import { isKindId } from "../registry";
import { KindIcon } from "../shell/KindIcon";
import { useOpenResource } from "../shell/navigation";
import type { KindId } from "../types";
import { refOf } from "../uri";
import { type DrawnNode, layoutGraph, type Place } from "./layout";

const COL = 150;
const ROW = 108;
const PAD = 28;
const HEAD = 30;
const SIZE = 48;
/** How far a node's name and the line under it reach below its icon. */
const UNDER = 36;

const GOING = new Set(["pending", "provisioning", "running"]);

/** What a role is drawn as: the kind whose icon and colours it takes. */
const LOOK: Record<GraphNode["role"], KindId> = {
  data: "dataset",
  workflow: "workflow",
  model: "model",
  function: "operator",
  unit: "computing-unit",
};

const LABEL: Record<string, string> = { reads: "reads", makes: "makes", uses: "uses", runsOn: "runs on" };

/** The graph of a chat, and whether the chat has started work: made something, or planned to. */
export function useChatGraph(rid: string, { enabled = true, live = false }: { enabled?: boolean; live?: boolean } = {}) {
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

/** Where the chat's nodes were put, kept for the chat's life in this tab. */
function useKeptPlaces(rid: string) {
  const key = `texera.graph.${rid}`;
  const kept = useRef<Map<string, Place> | null>(null);
  if (kept.current === null) {
    try {
      kept.current = new Map(JSON.parse(sessionStorage.getItem(key) ?? "[]") as [string, Place][]);
    } catch {
      kept.current = new Map();
    }
  }
  const save = (places: Map<string, Place>) => {
    kept.current = places;
    try {
      sessionStorage.setItem(key, JSON.stringify([...places]));
    } catch {
      // A tab that may not store keeps them for as long as the page is open.
    }
  };
  return { kept: kept.current, save };
}

export function ResourceGraph({ rid, graph, className }: { rid: string; graph: ConversationGraph; className?: string }) {
  const { kept, save } = useKeptPlaces(rid);
  const layout = useMemo(() => layoutGraph(graph, kept), [graph, kept]);
  useEffect(() => save(layout.places), [layout]);
  const [chosen, setChosen] = useState<string>();
  const centre = (id: string) => {
    const p = layout.places.get(id) as Place;
    return { x: PAD + p.col * COL + COL / 2, y: HEAD + PAD + p.row * ROW + SIZE / 2 };
  };
  const width = PAD * 2 + layout.columns * COL;
  const height = HEAD + PAD * 2 + layout.rows * ROW;
  const picked = layout.nodes.find(d => d.id === chosen);
  return (
    <div className={cn("relative min-h-0 overflow-auto bg-background", className)} data-resource-graph>
      <div className="relative" style={{ width, height }}>
        {/* Columns of dependency: data and work alternate, Used first and Made last. */}
        {Array.from({ length: layout.columns }, (_, col) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a band is its column
            key={col}
            className={cn("absolute top-0 bottom-0", col % 2 === 0 ? "bg-muted/35" : "bg-transparent")}
            style={{ left: PAD + col * COL, width: COL }}>
            <div className="px-2 pt-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase" data-graph-band={col}>
              {col === 0 ? "Used" : col === layout.columns - 1 && layout.columns > 1 ? "Made" : ""}
            </div>
          </div>
        ))}
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
          <defs>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {graph.edges.map(e => {
            if (!layout.places.has(e.from) || !layout.places.has(e.to)) return null;
            const a = centre(e.from);
            const b = centre(e.to);
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const r = SIZE / 2 + 4;
            let [x1, y1] = [a.x + ((b.x - a.x) / len) * r, a.y + ((b.y - a.y) / len) * r];
            let [x2, y2] = [b.x - ((b.x - a.x) / len) * r, b.y - ((b.y - a.y) / len) * r];
            // Within a column, an arrow leaves from under the name of the node above, and is labelled beside.
            const upright = Math.abs(b.x - a.x) < 1;
            if (upright && b.y > a.y) y1 = a.y + SIZE / 2 + UNDER;
            if (upright && b.y < a.y) y2 = b.y + SIZE / 2 + UNDER;
            if (upright) [x1, x2] = [a.x, b.x];
            const main = e.relation === "reads" || e.relation === "makes";
            return (
              <g key={`${e.from}>${e.to}>${e.relation}`} data-graph-edge={e.relation}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  markerEnd="url(#graph-arrow)"
                  className={main ? "stroke-muted-foreground" : "stroke-muted-foreground/45"}
                  strokeWidth={main ? 1.6 : 1}
                />
                <text
                  x={upright ? x1 + 6 : (x1 + x2) / 2}
                  y={upright ? (y1 + y2) / 2 + 3 : (y1 + y2) / 2 - 5}
                  textAnchor={upright ? "start" : "middle"}
                  className="fill-muted-foreground text-[10px]">
                  {LABEL[e.relation]}
                </text>
              </g>
            );
          })}
        </svg>
        {layout.nodes.map(d => {
          const c = centre(d.id);
          return <Node key={d.id} drawn={d} x={c.x} y={c.y} chosen={chosen === d.id} onChoose={() => setChosen(chosen === d.id ? undefined : d.id)} />;
        })}
      </div>
      {picked && <Detail drawn={picked} onClose={() => setChosen(undefined)} />}
    </div>
  );
}

/** A node: its kind's round icon, its state in the outline, its name beneath. */
function Node({ drawn, x, y, chosen, onChoose }: { drawn: DrawnNode; x: number; y: number; chosen: boolean; onChoose: () => void }) {
  const n = drawn.node;
  const kind: KindId | undefined = n ? LOOK[n.role] : drawn.planned?.kind && isKindId(drawn.planned.kind) ? drawn.planned.kind : undefined;
  const name = n ? n.name : drawn.planned?.name;
  const state = n?.state;
  const run = n?.runs?.[0];
  const sub = n
    ? n.role === "workflow" && run
      ? run.reused > 0
        ? `${run.reused} of ${run.steps} steps from earlier runs`
        : `${n.runs?.length} run${n.runs?.length === 1 ? "" : "s"}`
      : n.version !== undefined
        ? `v${n.version}`
        : n.rows !== undefined && n.rows !== null
          ? `${n.rows} rows`
          : ""
    : "planned";
  return (
    <button
      type="button"
      onClick={onChoose}
      className="group absolute flex w-36 -translate-x-1/2 flex-col items-center gap-1 text-center"
      style={{ left: x, top: y - SIZE / 2 }}
      data-graph-node={drawn.id}
      data-graph-role={n?.role ?? "planned"}
      data-graph-made={n?.made ? "true" : "false"}
      data-graph-state={state ?? ""}
      data-graph-planned={drawn.planned ? "true" : undefined}>
      <span
        className={cn(
          "flex items-center justify-center rounded-full border-2 bg-card shadow-xs transition",
          // Dashed means planned, and nothing else; a run that goes moves; one that failed is red.
          drawn.planned ? "border-dashed border-muted-foreground/60" : "border-border",
          state && GOING.has(state) && "animate-pulse border-primary",
          state === "failed" && "border-destructive",
          !drawn.planned && n && !n.made && "opacity-75",
          chosen && "ring-4 ring-primary/30"
        )}
        style={{ width: SIZE, height: SIZE }}>
        {kind ? <KindIcon kind={kind} className="size-8 rounded-full" /> : <span className="size-3 rounded-full bg-muted-foreground/50" />}
      </span>
      <span className="line-clamp-2 w-full text-xs leading-tight font-medium [overflow-wrap:anywhere]" title={name}>
        {name}
      </span>
      {sub && <span className="w-full truncate text-2xs text-muted-foreground">{sub}</span>}
    </button>
  );
}

/** What a node is, beside the graph: its kind, version and origin, a workflow's runs, and Open. */
function Detail({ drawn, onClose }: { drawn: DrawnNode; onClose: () => void }) {
  const { beside } = useOpenResource();
  const n = drawn.node;
  const ref = n ? refOf(n.uri) : undefined;
  return (
    <aside className="absolute top-3 right-3 w-72 space-y-2 rounded-xl border bg-card p-3 text-sm shadow-lg" data-graph-detail={drawn.id}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium [overflow-wrap:anywhere]">{n?.name ?? drawn.planned?.name}</p>
          <p className="text-xs text-muted-foreground">
            {n ? `${n.role}${n.version !== undefined ? ` · v${n.version}` : ""} · ${n.made ? "made in this chat" : "worked from"}` : `planned${drawn.planned?.detail ? `: ${drawn.planned.detail}` : ""}`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {n?.rows !== undefined && n.rows !== null && <p className="text-xs">{n.rows} rows</p>}
      {n?.runs && n.runs.length > 0 && (
        <ul className="space-y-1" data-graph-runs>
          {n.runs.map(run => (
            <Run key={run.uri} run={run} />
          ))}
        </ul>
      )}
      {ref && (
        <Button size="sm" variant="outline" onClick={() => beside(ref)} data-graph-open>
          <ArrowUpRight /> Open
        </Button>
      )}
    </aside>
  );
}

function Run({ run }: { run: GraphRun }) {
  const { beside } = useOpenResource();
  const ref = refOf(run.uri);
  return (
    <li>
      <button type="button" className="flex w-full items-center gap-1.5 text-left text-xs hover:underline" onClick={() => ref && beside(ref)}>
        <PhaseIcon phase={run.phase as never} className="size-3.5" />
        <span className="flex-1">{run.startedAt ? timeAgo(run.startedAt) : run.phase}</span>
        <span className="text-muted-foreground">
          {run.reused > 0 ? `${run.reused}/${run.steps} reused · ` : ""}
          {formatDuration(run.startedAt, run.finishedAt)}
        </span>
      </button>
    </li>
  );
}
