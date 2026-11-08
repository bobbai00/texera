// The things a chat's graph draws, each sized in ems of the drawing's type, so a zoom level
// sets their scale with one font size. A dataset is a capsule, a workflow a card (the one
// strong thing on the graph), a model or function a chip on the workflow that uses it, a run a
// pill in its unit's lane, the unit a plinth at the lane's foot, and a table a run made a small
// tile. Dashed means planned. A click goes into the thing; the graph gives way to its view.

import type { GraphNode, PlannedItem } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import {
  Blocks,
  Box,
  CheckCircle2,
  Circle,
  Cpu,
  Database,
  Loader2,
  PauseCircle,
  Table2,
  Workflow,
  XCircle,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  type DataItem,
  isGoing,
  type Level,
  type RunItem,
  type RunState,
  runStateOf,
  SOMEWHERE,
  type UnitItem,
  type WorkItem,
} from "./model";
import { lineOf } from "./steps";

/** What a pointer or a key does to a drawn thing: a click goes into it, a hover lights what it touches. */
export interface Handlers {
  onOpen: (id: string, from: HTMLElement) => void;
  onHover: (id: string | undefined) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The dot on what this chat made. */
function MadeDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("absolute size-[0.55em] rounded-full bg-primary", className)}
      title="Made in this chat"
      data-graph-made-dot
    />
  );
}

/** Props a drawn thing shares: what it is for tests and screen readers, and what it does. */
function nodeProps(id: string, label: string, h: Handlers) {
  return {
    "data-graph-node": id,
    "data-graph-measure": id,
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      h.onOpen(id, e.currentTarget);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        h.onOpen(id, e.currentTarget);
      }
    },
    onPointerEnter: () => h.onHover(id),
    onPointerLeave: () => h.onHover(undefined),
  } as const;
}

export function DataCard({
  item,
  level,
  h,
  className,
  style,
  result,
}: {
  item: DataItem;
  level: Level;
  h: Handlers;
  className?: string;
  style?: CSSProperties;
  /** It stands among the tables a run made, as wide as they are. */
  result?: boolean;
}) {
  const n = item.node;
  const name = n?.name ?? item.planned?.name ?? "";
  const planned = !!item.planned;
  const meta = planned
    ? "planned"
    : [n?.version !== undefined ? `v${n.version}` : "", item.files.join(", ")].filter(Boolean).join(" · ");
  if (level === "detail" && !planned) {
    return (
      <div
        {...nodeProps(item.id, `Dataset ${name}`, h)}
        data-graph-role="data"
        data-graph-made={n?.made ? "true" : "false"}
        style={style}
        className={cn(
          "absolute w-[13em] rounded-[1em] border border-kind-dataset/35 bg-card px-[0.85em] pt-[0.75em] pb-[0.6em] shadow-xs",
          className
        )}>
        {n?.made && <MadeDot className="top-[0.75em] right-[0.7em]" />}
        <div className="flex items-center gap-[0.55em] pr-[0.8em]">
          <span className="grid size-[2.2em] shrink-0 place-items-center rounded-full bg-kind-dataset/15 text-kind-dataset">
            <Database className="size-[1.15em]" />
          </span>
          <div className="grid min-w-0">
            <span className="line-clamp-2 leading-[1.25] font-semibold">{name}</span>
            <span className="truncate text-[0.86em] text-muted-foreground">
              Dataset{n?.version !== undefined ? ` · v${n.version}` : ""}
            </span>
          </div>
        </div>
        {item.files.length > 0 && (
          <ul className="mt-[0.55em] grid gap-[0.12em] border-t pt-[0.35em]">
            {item.files.map(f => (
              <li
                key={f}
                data-graph-row={`file:${f}`}
                data-graph-file={f}
                className="truncate py-[0.22em] font-mono text-[0.86em] font-semibold"
                title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div
      {...nodeProps(item.id, `${planned ? "Planned dataset" : "Dataset"} ${name}`, h)}
      data-graph-role={planned ? "planned" : "data"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-made={n?.made ? "true" : "false"}
      style={style}
      className={cn(
        "absolute flex items-center gap-[0.6em] rounded-[1.6em] border bg-card py-[0.45em] pr-[1.5em] pl-[0.45em] shadow-xs",
        result ? (level === "overview" ? "w-[9.5em]" : "w-[10em]") : level === "overview" ? "w-[12em]" : "w-[13em]",
        planned ? "border-dashed border-muted-foreground/50 bg-transparent shadow-none" : "border-kind-dataset/35",
        className
      )}>
      {n?.made && <MadeDot className="top-1/2 right-[0.6em] -translate-y-1/2" />}
      <span
        className={cn(
          "grid size-[2.2em] shrink-0 place-items-center rounded-full",
          planned
            ? "border border-dashed border-muted-foreground/50 text-muted-foreground"
            : "bg-kind-dataset/15 text-kind-dataset"
        )}>
        <Database className="size-[1.15em]" />
      </span>
      <div className="grid min-w-0">
        <span
          className={cn("line-clamp-2 leading-[1.25] font-semibold", planned && "text-muted-foreground")}
          title={name}>
          {name}
        </span>
        {level === "standard" && meta && <span className="truncate text-[0.86em] text-muted-foreground">{meta}</span>}
      </div>
    </div>
  );
}

export function ResultTile({
  node,
  of,
  op,
  level,
  h,
  className,
  style,
}: {
  node: GraphNode;
  /** The workflow that made it. */
  of?: string;
  op?: string;
  level: Level;
  h: Handlers;
  className?: string;
  style?: CSSProperties;
}) {
  const rows = node.rows ?? undefined;
  return (
    <div
      {...nodeProps(node.uri, `Table ${node.name}`, h)}
      data-graph-role="data"
      data-graph-made="true"
      data-graph-of={of}
      style={style}
      className={cn(
        "absolute flex items-center gap-[0.5em] rounded-[0.6em] border bg-card py-[0.4em] pr-[0.65em] pl-[0.45em] shadow-xs",
        level === "overview" ? "w-[9.5em]" : "w-[10em]",
        className
      )}>
      <span className="grid size-[1.9em] shrink-0 place-items-center rounded-[0.45em] bg-kind-dataset/10 text-kind-dataset">
        <Table2 className="size-[1em]" />
      </span>
      <div className="grid min-w-0">
        <span className="truncate font-mono text-[0.95em] font-semibold" title={node.name}>
          {node.name}
        </span>
        {level !== "overview" && (
          <span className="truncate text-[0.86em] text-muted-foreground">
            {rows !== undefined ? plural(rows, "row") : "kept"}
            {level === "detail" && op ? ` · ${op}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/** A model or function a workflow uses, on its card. */
export function UseChip({
  node,
  planned,
  level,
  hot,
  h,
}: {
  node?: GraphNode;
  planned?: PlannedItem;
  level: Level;
  hot?: boolean;
  h: Handlers;
}) {
  const model = node ? node.role === "model" : planned?.kind === "model";
  const Icon = model ? Box : Blocks;
  const name = node?.name ?? planned?.name ?? "";
  const id = node?.uri;
  const pick = id
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `${model ? "Model" : "Function"} ${name}`,
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          e.stopPropagation();
          h.onOpen(id, e.currentTarget);
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            h.onOpen(id, e.currentTarget);
          }
        },
        onPointerEnter: () => h.onHover(id),
        onPointerLeave: () => h.onHover(undefined),
      }
    : {};
  return (
    <span
      {...pick}
      data-graph-role={planned ? "planned" : model ? "model" : "function"}
      data-graph-uses={id}
      data-graph-planned={planned ? "true" : undefined}
      title={`${model ? "Model" : "Function"} ${name}${node?.version !== undefined ? ` v${node.version}` : ""}${planned ? ", planned" : ""}`}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-[0.35em] rounded-[0.45em] border text-[0.86em] leading-[1.25] whitespace-nowrap",
        level === "overview" ? "p-[0.28em]" : "py-[0.2em] pr-[0.5em] pl-[0.35em]",
        planned
          ? "border-dashed border-muted-foreground/50 text-muted-foreground"
          : model
            ? "border-kind-model/30 bg-kind-model/10"
            : "border-kind-operator/30 bg-kind-operator/10",
        hot &&
          (model ? "border-kind-model ring-2 ring-kind-model/30" : "border-kind-operator ring-2 ring-kind-operator/30"),
        id && "cursor-pointer"
      )}>
      <Icon className={cn("size-[1.05em] shrink-0", planned ? "" : model ? "text-kind-model" : "text-kind-operator")} />
      {level !== "overview" && (
        <>
          <span className="truncate">{name}</span>
          {node?.version !== undefined && <span className="text-muted-foreground tabular-nums">v{node.version}</span>}
        </>
      )}
    </span>
  );
}

function PlanPill({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-dashed border-muted-foreground/60 px-[0.6em] py-[0.08em] text-[0.86em] text-muted-foreground"
      title={title}>
      {children}
    </span>
  );
}

export function WorkCard({
  work,
  results,
  level,
  nodes,
  hot,
  h,
  className,
  style,
}: {
  work: WorkItem;
  /** The tables its runs made: the steps that made them are marked. */
  results: string[];
  level: Level;
  nodes: Map<string, GraphNode>;
  hot?: string;
  h: Handlers;
  className?: string;
  style?: CSSProperties;
}) {
  const n = work.node;
  const planned = !!work.planned;
  const name = n?.name ?? work.planned?.name ?? "";
  const outs = new Set(results.map(id => nodes.get(id)?.step).filter(Boolean));
  return (
    <div
      {...nodeProps(work.id, `${planned ? "Planned workflow" : "Workflow"} ${name}`, h)}
      data-graph-role={planned ? "planned" : "workflow"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-made={n?.made ? "true" : "false"}
      style={style}
      className={cn(
        "absolute overflow-hidden rounded-[0.95em] border bg-card",
        level === "overview" ? "w-[13.5em]" : level === "detail" ? "w-[21em]" : "w-[17em]",
        planned
          ? "border-dashed border-muted-foreground/50 bg-transparent"
          : "border-kind-workflow/45 shadow-[0_1px_2px_oklch(0.3_0.03_210/0.08),0_8px_22px_-10px_color-mix(in_oklch,var(--kind-workflow)_55%,transparent)]",
        className
      )}>
      {n?.made && <MadeDot className="top-[0.75em] right-[0.7em]" />}
      <div className="flex items-start gap-[0.6em] pt-[0.7em] pr-[1.5em] pb-[0.35em] pl-[0.8em]">
        <span
          className={cn(
            "grid size-[2.15em] shrink-0 place-items-center rounded-[0.6em]",
            planned
              ? "border border-dashed border-muted-foreground/50 text-muted-foreground"
              : "bg-kind-workflow text-card"
          )}>
          <Workflow className="size-[1.15em]" />
        </span>
        <div className="grid min-w-0 pt-[0.1em]">
          <span
            className={cn("leading-[1.25] font-semibold", "line-clamp-2", planned && "text-muted-foreground")}
            title={name}>
            {name}
          </span>
          {level !== "overview" && (
            <span className="truncate text-[0.86em] text-muted-foreground">
              {planned
                ? (work.planned?.detail ?? "Workflow")
                : `Workflow${n?.version !== undefined ? ` · v${n.version}` : ""}`}
            </span>
          )}
        </div>
      </div>
      {planned && (
        <div className="pr-[0.85em] pb-[0.6em] pl-[3.55em]">
          <PlanPill>planned</PlanPill>
        </div>
      )}
      <div className={level === "overview" ? "pb-[0.35em]" : "pb-[0.2em]"} />
      {level === "detail" && work.steps.length > 0 ? (
        <ol className="grid gap-[0.12em] border-t px-[0.6em] pt-[0.45em] pb-[0.55em]" data-graph-steps>
          {work.steps.map(step => {
            const line = lineOf(step, nodes);
            const out = outs.has(step.id);
            return (
              <li
                key={step.id}
                data-graph-row={step.id}
                data-graph-step={step.id}
                className={cn(
                  "grid grid-cols-[5.6em_minmax(0,1fr)] items-center gap-[0.55em] rounded-[0.4em] px-[0.3em] py-[0.22em] text-[0.86em]",
                  out && "bg-kind-dataset/10",
                  line.file && !line.uses && "bg-kind-dataset/5"
                )}>
                <span className="truncate font-mono text-[0.95em]" title={step.id}>
                  {step.id}
                </span>
                <span className="flex min-w-0 items-center gap-[0.4em] text-muted-foreground">
                  {line.uses ? (
                    <>
                      {step.type === "predict" || line.file ? (
                        <span className="shrink-0 font-medium text-foreground">
                          {line.op === "scan" ? "scan" : "predict"}
                        </span>
                      ) : null}
                      {line.file && <span className="truncate">{line.file}</span>}
                      <UseChip
                        node={line.uses}
                        level={line.file ? "overview" : "standard"}
                        hot={hot === line.uses.uri}
                        h={h}
                      />
                      {!line.file && line.text && <span className="truncate">{line.text}</span>}
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 font-medium text-foreground">{line.op}</span>
                      <span className="truncate" title={line.text}>
                        {line.text}
                      </span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        (work.uses.length > 0 || work.plannedUses.length > 0) && (
          <div
            className="flex flex-wrap items-center gap-[0.35em] border-t bg-muted/40 px-[0.8em] pt-[0.5em] pb-[0.7em]"
            data-graph-uses-row>
            {level === "standard" && (
              <span className="mr-[0.15em] text-[0.76em] font-semibold tracking-wide text-muted-foreground uppercase">
                Uses
              </span>
            )}
            {work.uses.map(u => (
              <UseChip key={u.uri} node={u} level={level} hot={hot === u.uri} h={h} />
            ))}
            {work.plannedUses.map(p => (
              <UseChip key={`${p.kind}:${p.name}`} planned={p} level={level} h={h} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** How a run box stands, in a word and an icon. */
const RUN_LOOK: Record<RunState, { word: string; Icon: typeof Circle; tone: string }> = {
  completed: { word: "Completed", Icon: CheckCircle2, tone: "text-success" },
  running: { word: "Running", Icon: Loader2, tone: "text-kind-execution" },
  starting: { word: "Starting", Icon: Loader2, tone: "text-kind-execution" },
  paused: { word: "Paused", Icon: PauseCircle, tone: "text-muted-foreground" },
  failed: { word: "Failed", Icon: XCircle, tone: "text-destructive" },
  cancelled: { word: "Cancelled", Icon: XCircle, tone: "text-destructive" },
  planned: { word: "Planned", Icon: Circle, tone: "text-muted-foreground" },
  idle: { word: "Not run yet", Icon: Circle, tone: "text-muted-foreground/70" },
};

const seconds = (from?: string, to?: string) =>
  from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)} s` : "";

/** A run box: the runs of a workflow on one unit, standing in the unit's lane. */
export function RunBox({
  box,
  unitName,
  level,
  h,
  className,
  style,
}: {
  box: RunItem;
  unitName?: string;
  level: Level;
  h: Handlers;
  className?: string;
  style?: CSSProperties;
}) {
  const state = runStateOf(box);
  const look = RUN_LOOK[state];
  const going = isGoing(state);
  const run = box.runs[0];
  const count = box.runs.length;
  const waiting = state === "planned" || state === "idle";
  const facts = run
    ? [
        seconds(run.startedAt, run.finishedAt),
        plural(run.steps, "step"),
        run.reused > 0 ? `${run.reused} reused` : "",
      ].filter(Boolean)
    : [];
  const where = unitName ? ` on ${unitName}` : "";
  const label = waiting
    ? `${look.word}${where}`
    : `${plural(count, "run")}${where}, the newest ${look.word.toLowerCase()}`;
  return (
    <div
      {...nodeProps(box.id, `Run ${label}`, h)}
      data-graph-role={state === "planned" ? "planned" : "run"}
      data-graph-planned={state === "planned" ? "true" : undefined}
      data-graph-state={state}
      data-graph-unit={box.unit}
      data-graph-of={box.work}
      data-graph-runs={count}
      title={box.planned && !waiting ? `${label}; ${box.planned.name}` : label}
      style={style}
      className={cn(
        "absolute overflow-hidden border",
        level === "overview" ? "grid size-[2.3em] place-items-center rounded-full" : "w-[9em] rounded-[1.2em]",
        waiting
          ? "border-dashed border-muted-foreground/50 bg-background text-muted-foreground"
          : "border-kind-execution/60 bg-[color-mix(in_oklch,var(--kind-execution)_11%,var(--card))] shadow-xs",
        className
      )}>
      {level === "overview" ? (
        <look.Icon className={cn("size-[1.15em]", look.tone, going && "animate-spin")} aria-hidden />
      ) : (
        <>
          <div className="flex h-[2.4em] items-center gap-[0.45em] pr-[0.75em] pl-[0.6em]">
            <look.Icon className={cn("size-[1.15em] shrink-0", look.tone, going && "animate-spin")} aria-hidden />
            <span className={cn("truncate text-[0.92em]", waiting ? "font-medium" : "font-semibold")}>{look.word}</span>
            {count > 1 && (
              <span
                className="ml-auto shrink-0 font-mono text-[0.82em] text-muted-foreground tabular-nums"
                data-graph-count>
                ×{count}
              </span>
            )}
          </div>
          {level === "detail" && facts.length > 0 && (
            <div className="grid gap-[0.15em] px-[0.75em] pb-[0.5em] text-[0.8em] text-muted-foreground tabular-nums">
              {facts.map(f => (
                <span key={f} className="truncate">
                  {f}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {going && (
        <div className="absolute inset-x-0 bottom-0 h-[0.18em] overflow-hidden bg-kind-execution/15">
          <div className="absolute inset-y-0 w-1/3 animate-working bg-kind-execution" />
        </div>
      )}
    </div>
  );
}

/** What the plan will run again where a run box has run: said under it. */
export function RerunNote({ box, style }: { box: RunItem; style?: CSSProperties }) {
  if (!box.planned || !box.runs.length) return null;
  return (
    <span
      className="absolute -translate-x-1/2 rounded-full border border-dashed border-muted-foreground/60 bg-background px-[0.6em] text-[0.78em] whitespace-nowrap text-muted-foreground"
      style={style}
      title={box.planned.detail ?? box.planned.name}
      data-graph-rerun={box.id}>
      + run planned
    </span>
  );
}

/** A unit at the foot of its lane: its name, and how it stands. */
export function UnitFoot({
  unit,
  id,
  level,
  h,
  className,
  style,
  measure,
}: {
  unit?: UnitItem;
  id: string;
  level: Level;
  h?: Handlers;
  className?: string;
  style?: CSSProperties;
  /** Drawn only to be measured. */
  measure?: boolean;
}) {
  const n = unit?.node;
  const planned = !!unit?.planned;
  const unknown = id === SOMEWHERE;
  const name = unknown ? "Unit not known" : (n?.name ?? unit?.planned?.name ?? "");
  const state = planned ? "planned" : (n?.state ?? "");
  const starting = !!state && !["ready", "planned", "terminated", "failed"].includes(state);
  const props =
    !measure && !unknown && h
      ? nodeProps(id, `${planned ? "Planned computing unit" : "Computing unit"} ${name}`, h)
      : {};
  return (
    <div
      {...props}
      data-graph-measure={measure ? `foot:${id}` : undefined}
      data-graph-role={measure ? undefined : planned ? "planned" : "unit"}
      data-graph-planned={planned && !measure ? "true" : undefined}
      data-graph-foot={measure ? undefined : id}
      style={style}
      className={cn(
        "absolute flex items-center gap-[0.55em] rounded-t-[0.8em] rounded-b-[0.35em] border border-b-[0.3em] py-[0.5em] pr-[1.4em] pl-[0.5em]",
        level === "overview" ? "w-[9.5em]" : "w-[11.5em]",
        planned || unknown
          ? "border-dashed border-muted-foreground/50 bg-background"
          : "border-kind-computing-unit/40 border-b-kind-computing-unit/70 bg-[color-mix(in_oklch,var(--kind-computing-unit)_9%,var(--card))]",
        className
      )}>
      {n?.made && <MadeDot className="top-[0.7em] right-[0.6em]" />}
      <span
        className={cn(
          "grid size-[2em] shrink-0 place-items-center rounded-[0.5em]",
          planned || unknown
            ? "border border-dashed border-muted-foreground/50 text-muted-foreground"
            : "bg-kind-computing-unit/15 text-kind-computing-unit"
        )}>
        <Cpu className="size-[1.1em]" />
      </span>
      <span className="grid min-w-0">
        <span
          className={cn(
            "line-clamp-2 text-[0.95em] leading-[1.25] font-semibold",
            (planned || unknown) && "text-muted-foreground"
          )}
          title={name}>
          {name}
        </span>
        {level !== "overview" && !unknown && (
          <span className="flex min-w-0 items-center gap-[0.35em] text-[0.82em] text-muted-foreground">
            {state && !planned && (
              <span
                className={cn(
                  "size-[0.55em] shrink-0 rounded-full",
                  state === "ready" ? "bg-success" : state === "failed" ? "bg-destructive" : "animate-pulse bg-primary"
                )}
              />
            )}
            <span className="truncate">
              {planned
                ? `planned${unit?.planned?.detail ? `: ${unit.planned.detail}` : ""}`
                : [state ? `${state}${starting ? "…" : ""}` : "", n?.made ? "made here" : ""]
                    .filter(Boolean)
                    .join(" · ") || "computing unit"}
            </span>
          </span>
        )}
      </span>
    </div>
  );
}
