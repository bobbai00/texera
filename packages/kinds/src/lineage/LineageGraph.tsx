// The lineage graph on screen: a card per resource, an arrow per thing that happened, the
// words for it on the arrow. Read left to right. Nothing here is edited; a card opens what it
// names beside the page.

import { useQuery } from "@tanstack/react-query";
import { cn, formatDuration, formatNumber, Skeleton, timeAgo, useDark } from "@texera/ui";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  getBezierPath,
  getViewportForBounds,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { History, Table2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo } from "react";
import { versionsQuery } from "../queries";
import { KINDS } from "../registry";
import { edgeOptions } from "../shell/canvas";
import { MadeBy, useMadeBy } from "../shell/Chips";
import { KindIcon } from "../shell/KindIcon";
import { useOpenResource } from "../shell/navigation";
import { whyNot } from "../shell/OpenError";
import { RanOn, useRanOn } from "../shell/RanOn";
import type { ResourceRef } from "../types";
import { uriOf } from "../uri";
import { type LabelPlace, layoutLineage, placeLabels } from "./layout";
import type { LineageGraph as Graph, Level, LineageArrow, LineageNode } from "./model";
import { cardNameQuery } from "./queries";

/**
 * The cards of a level are all one size, so the graph is laid out before anything is measured.
 * The level of resources has few columns and says more on an arrow ("read iris.csv"); data flow
 * has a column more and says less, so its cards and the room between them are narrower. A card
 * has room for four lines: its name, what it is, where an execution ran, who made it.
 */
const CARD: Record<Level, { width: number; height: number }> = {
  resources: { width: 248, height: 80 },
  flow: { width: 224, height: 80 },
};
const SPACING: Record<Level, { column: number; row: number }> = {
  resources: { column: 200, row: 28 },
  flow: { column: 136, row: 28 },
};
/** A graph is never shown smaller than this: when it does not fit, the page's own card and its neighbours are what is in view. */
const SMALLEST = 0.8;
const PADDING = 0.08;

type CardNode = FlowNode<{ card: LineageNode; level: Level; onUnfold: () => void }, "card">;
type ArrowEdge = FlowEdge<{ arrow: LineageArrow; place: LabelPlace; room: number }, "arrow">;

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** A long name cut in its middle, so its start and its extension both stay. */
export function shorten(text: string, most = 20): string {
  return text.length <= most ? text : `${text.slice(0, most - 9)}…${text.slice(-8)}`;
}

/**
 * The frame every card shares: an icon, a name, one line that says what it is, and who made it.
 * A card that opens what it names is a button under its words, so a link in them (the chat that
 * made it) is a target of its own.
 */
function Frame({
  card,
  level,
  icon,
  name,
  line,
  more,
  by,
  title,
  onOpen,
  muted,
  dashed,
}: {
  card: LineageNode;
  level: Level;
  icon: ReactNode;
  name: ReactNode;
  line: ReactNode;
  /** A third line, for a card that says more: where an execution ran. */
  more?: ReactNode;
  /** Who made it. */
  by?: ReactNode;
  title?: string;
  onOpen?: () => void;
  muted?: boolean;
  dashed?: boolean;
}) {
  // A card that is not dragged or picked gets no pointer from the graph: it takes its own.
  const frame = cn(
    "pointer-events-auto relative flex items-center gap-2 rounded-xl border bg-card px-2.5 shadow-sm",
    dashed && "border-dashed bg-transparent shadow-none",
    card.root && "border-primary ring-4 ring-primary/15",
    onOpen && "transition-colors hover:border-foreground/30 hover:bg-accent/40"
  );
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
      <div
        className={frame}
        style={CARD[level]}
        title={title}
        data-lineage-card={card.type}
        data-root={card.root || undefined}>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={title}
            className="nopan absolute inset-0 cursor-pointer rounded-xl"
            data-lineage-open
          />
        )}
        <span className="pointer-events-none contents">
          {icon}
          <span className="min-w-0 flex-1 text-left">
            <span className={cn("block truncate text-sm font-medium", muted && "text-muted-foreground")}>{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{line}</span>
            {more && <span className="block truncate text-xs">{more}</span>}
            {by && <span className="block min-w-0 text-xs text-muted-foreground">{by}</span>}
          </span>
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
    </>
  );
}

/** A resource, one version of it, or a file of a version: named by the catalog. */
function ResourceCard({ card, level }: { card: LineageNode; level: Level }) {
  const ref = card.ref as ResourceRef;
  const { beside } = useOpenResource();
  const { data, error, isPending } = useQuery(cardNameQuery(uriOf(ref, { version: false })));
  const label = KINDS[ref.kind].label;
  const why = error ? whyNot(error) : undefined;
  const named = data?.metadata.name;
  const versions = card.versions ?? [];
  const which =
    ref.vno !== undefined
      ? `v${ref.vno}`
      : level === "resources" && versions.length === 1
        ? `v${versions[0]}`
        : versions.length > 1
          ? plural(versions.length, "version")
          : "";
  const file = card.type === "file" ? (card.path ?? "") : undefined;
  // Who made the version the card stands for, the newest when it stands for several; a
  // resource without versions was made with the resource.
  const vno = ref.vno ?? (versions.length > 0 ? Math.max(...versions) : undefined);
  const { data: listed } = useQuery({ ...versionsQuery(ref.rid), enabled: vno !== undefined && why === undefined });
  const maker = vno === undefined ? data?.metadata : listed?.items.find(v => v.vno === vno);
  const several = ref.vno === undefined && versions.length > 1;
  const made = useMadeBy(maker?.createdBy, maker?.origin).said;
  const name =
    why === "forbidden"
      ? "Not shared with you"
      : why === "not_found"
        ? "No longer exists"
        : file !== undefined
          ? (file.split("/").at(-1) ?? file)
          : (named ?? (isPending ? <Skeleton className="my-1 h-3 w-28" /> : label));
  // A file says which version of which dataset it is of; anything else says its kind.
  const line = (file !== undefined ? ["File", which, named] : [label, which]).filter(Boolean).join(" · ");
  const openable = !card.root && !why;
  return (
    <Frame
      card={card}
      level={level}
      icon={<KindIcon kind={ref.kind} className="size-7" />}
      name={name}
      line={line}
      by={maker && <MadeBy createdBy={maker.createdBy} origin={maker.origin} prefix={several ? `v${vno} ` : ""} />}
      title={[file ?? named, line, made && `${several ? `v${vno}: ` : ""}${made}`].filter(Boolean).join("\n")}
      muted={why !== undefined}
      onOpen={openable ? () => beside(data ? { ...ref, parent: data.metadata.parent } : ref) : undefined}
    />
  );
}

const PHASE_DOT: Record<string, string> = {
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-destructive",
  running: "bg-warning",
  paused: "bg-warning",
  provisioning: "bg-warning",
};

function ExecutionCard({ card, level }: { card: LineageNode; level: Level }) {
  const { beside } = useOpenResource();
  const x = card.execution;
  const phase = x?.phase ?? "pending";
  const took = formatDuration(x?.startedAt, x?.finishedAt);
  // What came out of it is on screen at the level of data flow; here it is a count.
  const detail = level === "resources" ? (card.results ? plural(card.results, "result") : "") : took;
  const line = [phase.replace(/^./, c => c.toUpperCase()), detail].filter(Boolean).join(" · ");
  // Everything the card says, in full where its lines are cut short.
  const ran = useRanOn({ unit: x?.unit, profile: x?.profile, warehouse: x?.warehouse }).said;
  const made = useMadeBy(x?.createdBy, x?.origin).said;
  return (
    <Frame
      card={card}
      level={level}
      icon={<KindIcon kind="execution" className="size-7" />}
      name={x?.name ?? "Execution"}
      line={
        <>
          <span
            className={cn(
              "mr-1.5 inline-block size-1.5 rounded-full align-middle",
              PHASE_DOT[phase] ?? "bg-muted-foreground"
            )}
          />
          {line}
        </>
      }
      more={x && <RanOn unit={x.unit} profile={x.profile} warehouse={x.warehouse} className="block" />}
      by={x?.createdBy && <MadeBy createdBy={x.createdBy} origin={x.origin} />}
      title={[
        x?.name,
        `Execution · ${line}`,
        x?.vno !== undefined ? `ran version ${x.vno}` : "",
        x ? timeAgo(x.createdAt) : "",
        ran,
        made,
      ]
        .filter(Boolean)
        .join("\n")}
      onOpen={card.root || !card.ref ? undefined : () => beside(card.ref as ResourceRef)}
    />
  );
}

/** What one output port of an execution produced: no resource of the catalog, so it says what it is in words. */
function ResultCard({ card, level }: { card: LineageNode; level: Level }) {
  const { beside } = useOpenResource();
  const name = card.port && card.port !== "output-0" ? `${card.operator} · ${card.port}` : card.operator;
  const line = ["Result", card.rows !== undefined ? plural(card.rows, "row") : ""].filter(Boolean).join(" · ");
  return (
    <Frame
      card={card}
      level={level}
      icon={
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Table2 className="size-4" />
        </span>
      }
      name={name}
      line={line}
      title={[`${card.operator} · ${card.port}`, line, card.table ? `table ${card.table}` : ""]
        .filter(Boolean)
        .join("\n")}
      onOpen={card.ref ? () => beside(card.ref as ResourceRef) : undefined}
    />
  );
}

function FoldCard({ card, level, onUnfold }: { card: LineageNode; level: Level; onUnfold: () => void }) {
  return (
    <Frame
      card={card}
      level={level}
      dashed
      icon={
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <History className="size-4" />
        </span>
      }
      name={plural(card.count ?? 0, "earlier execution")}
      line="Show them"
      onOpen={onUnfold}
    />
  );
}

function Card({ data }: NodeProps<CardNode>) {
  const { card, level, onUnfold } = data;
  if (card.type === "execution") return <ExecutionCard card={card} level={level} />;
  if (card.type === "result") return <ResultCard card={card} level={level} />;
  if (card.type === "fold") return <FoldCard card={card} level={level} onUnfold={onUnfold} />;
  return <ResourceCard card={card} level={level} />;
}

/** An arrow and the words for what happened along it. */
function Arrow({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<ArrowEdge>) {
  const [path, middleX, middleY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  if (!data) return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
  const { arrow, place, room } = data;
  // A bundle's words stand beside the card, one slot per bundle; any other arrow's on its middle.
  const slot = place.at === "source" || place.at === "target" ? (place.slot - (place.slots - 1) / 2) * 26 : 0;
  const transform =
    place.at === "source"
      ? `translate(0, -50%) translate(${sourceX + 8}px, ${sourceY + slot}px)`
      : place.at === "target"
        ? `translate(-100%, -50%) translate(${targetX - 14}px, ${targetY + slot}px)`
        : `translate(-50%, -50%) translate(${middleX}px, ${middleY}px)`;
  const words = [arrow.label, arrow.detail].filter(Boolean).join(" ");
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, ...(arrow.declared ? { strokeDasharray: "6 5" } : {}) }}
      />
      {place.at !== "none" && (
        <EdgeLabelRenderer>
          <div
            data-edge={arrow.relation}
            title={arrow.declared ? `${words}: named in its spec, not read by an execution` : words}
            className="nodrag nopan pointer-events-auto absolute truncate rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-xs"
            style={{ transform, maxWidth: room }}>
            <span className="font-medium text-foreground">{arrow.label}</span>
            {arrow.detail && <> {shorten(arrow.detail)}</>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { card: Card };
const edgeTypes = { arrow: Arrow };

/**
 * Brings the graph into view whenever it changes: all of it when it fits at a size that reads,
 * else the page's own cards and what they touch, at the smallest size that reads.
 */
function useInView(shape: string, near: ReadonlySet<string>) {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const ready = useNodesInitialized();
  const width = useStore(s => s.width);
  const height = useStore(s => s.height);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the graph on screen; a new one is brought into view again
  useEffect(() => {
    if (!ready || !width || !height) return;
    const all = getNodes();
    if (!all.length) return;
    let view = getViewportForBounds(getNodesBounds(all), width, height, 0.05, 1, PADDING);
    if (view.zoom < SMALLEST) {
      // Too large to read whole: as much of it as reads, around the page's own cards.
      const some = all.filter(n => near.has(n.id));
      view = getViewportForBounds(getNodesBounds(some.length ? some : all), width, height, SMALLEST, SMALLEST, PADDING);
    }
    void setViewport(view);
  }, [ready, width, height, shape, near, getNodes, getNodesBounds, setViewport]);
}

function Canvas({ graph, level, onUnfold }: { graph: Graph; level: Level; onUnfold: () => void }) {
  const drawn = useMemo(() => {
    const box = CARD[level];
    const spacing = SPACING[level];
    const at = layoutLineage(graph.nodes, graph.arrows, box, spacing);
    const places = placeLabels(graph.arrows);
    const roots = new Set(graph.nodes.filter(n => n.root).map(n => n.id));
    const near = new Set(roots);
    for (const a of graph.arrows) {
      if (roots.has(a.from)) near.add(a.to);
      if (roots.has(a.to)) near.add(a.from);
    }
    const nodes: CardNode[] = graph.nodes.map(card => ({
      id: card.id,
      type: "card",
      position: at[card.id] ?? { x: 0, y: 0 },
      data: { card, level, onUnfold },
      ...box,
      draggable: false,
      selectable: false,
      focusable: false,
    }));
    const edges: ArrowEdge[] = graph.arrows.map(arrow => ({
      id: arrow.id,
      source: arrow.from,
      target: arrow.to,
      type: "arrow",
      data: { arrow, place: places.get(arrow.id) ?? { at: "middle" }, room: spacing.column - 16 },
      focusable: false,
    }));
    return { nodes, edges, near, shape: `${level}|${graph.nodes.map(n => n.id).join("|")}` };
  }, [graph, level, onUnfold]);
  // The graph keeps what it measured of each card; the cards and arrows are the model's.
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(drawn.nodes);
  const [edges, setEdges] = useEdgesState<ArrowEdge>(drawn.edges);
  useEffect(() => {
    setNodes(drawn.nodes);
    setEdges(drawn.edges);
  }, [drawn, setNodes, setEdges]);
  useInView(drawn.shape, drawn.near);
  const dark = useDark();
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={edgeOptions}
      onNodesChange={onNodesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnDoubleClick={false}
      minZoom={0.3}
      maxZoom={1.5}
      colorMode={dark ? "dark" : "light"}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <Controls showInteractive={false} className="!rounded-lg !border !shadow-none" />
    </ReactFlow>
  );
}

/** The graph of one resource's lineage at one level. */
export function LineageGraph(props: { graph: Graph; level: Level; onUnfold: () => void }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
