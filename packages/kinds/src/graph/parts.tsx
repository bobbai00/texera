// The things a chat's graph draws, each sized in ems of the drawing's type, so a zoom level
// sets their scale with one font size. A dataset is a capsule, a workflow a card (the one
// strong thing on the graph), a table a run made a small tile, a model or function a chip on
// the workflow that uses it, and a unit the frame around what ran on it. Dashed means planned.

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
import type { DataItem, Level, UnitItem, WorkItem } from "./model";
import { lineOf } from "./steps";

/** What a pointer or a key does to a drawn thing. */
export interface Handlers {
  onChoose: (id: string) => void;
  onHover: (id: string | undefined) => void;
  onOpen?: (id: string) => void;
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
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      h.onChoose(id);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      h.onOpen?.(id);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        h.onChoose(id);
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
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          h.onChoose(id);
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            h.onChoose(id);
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

const GOING = new Set(["pending", "provisioning", "running", "starting", "submitted"]);

/** How a workflow's last run stands, in a word and an icon. */
function runState(state: string | undefined) {
  if (!state) return { word: "Not run yet", Icon: Circle, tone: "text-muted-foreground/60", spin: false };
  if (state === "completed") return { word: "Completed", Icon: CheckCircle2, tone: "text-success", spin: false };
  if (state === "failed" || state === "cancelled")
    return { word: state === "failed" ? "Failed" : "Cancelled", Icon: XCircle, tone: "text-destructive", spin: false };
  if (state === "paused") return { word: "Paused", Icon: PauseCircle, tone: "text-muted-foreground", spin: false };
  return { word: state === "running" ? "Running" : "Starting", Icon: Loader2, tone: "text-primary", spin: true };
}

export function WorkCard({
  work,
  level,
  nodes,
  hot,
  h,
  className,
  style,
}: {
  work: WorkItem;
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
  const run = n?.runs?.[0];
  const state = runState(n?.state);
  const going = !!n?.state && GOING.has(n.state);
  const facts = [
    run && n?.state !== undefined ? plural(run.steps, "step") : "",
    run && run.reused > 0 ? `${run.reused} reused` : "",
    run?.startedAt && run.finishedAt
      ? `${((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`
      : "",
  ].filter(Boolean);
  const outs = new Set(work.results.map(id => nodes.get(id)?.step).filter(Boolean));
  return (
    <div
      {...nodeProps(work.id, `${planned ? "Planned workflow" : "Workflow"} ${name}`, h)}
      data-graph-role={planned ? "planned" : "workflow"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-made={n?.made ? "true" : "false"}
      data-graph-state={n?.state ?? ""}
      data-graph-runs-on={work.unit}
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
      <div
        className={cn(
          "flex min-w-0 items-center gap-[0.4em] pr-[0.85em] pb-[0.55em] text-[0.86em] text-muted-foreground tabular-nums",
          level === "overview" ? "pl-[0.85em]" : "pl-[3.55em]"
        )}>
        {planned ? (
          <PlanPill>planned</PlanPill>
        ) : (
          <>
            <state.Icon className={cn("size-[1.1em] shrink-0", state.tone, state.spin && "animate-spin")} aria-hidden />
            <span className="truncate">
              <span className="font-semibold text-foreground">{state.word}</span>
              {level !== "overview" && facts.length > 0 && ` · ${facts.join(" · ")}`}
            </span>
          </>
        )}
      </div>
      {work.plannedRun && level !== "overview" && (
        <div className="pr-[0.85em] pb-[0.6em] pl-[3.55em]">
          <PlanPill title={work.plannedRun.detail}>{work.plannedRun.name}</PlanPill>
        </div>
      )}
      {going && (
        <div className="relative h-[0.2em] overflow-hidden bg-primary/15">
          <div className="absolute inset-y-0 w-1/4 animate-working bg-primary" />
        </div>
      )}
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

/** A unit frame's head: the unit's name, and how it stands. */
export function UnitHead({ unit, level, empty }: { unit: UnitItem; level: Level; empty?: boolean }) {
  const n = unit.node;
  const planned = !!unit.planned;
  const name = n?.name ?? unit.planned?.name ?? "";
  const state = planned ? "planned" : (n?.state ?? "");
  const starting = !!state && state !== "ready" && state !== "planned" && state !== "terminated" && state !== "failed";
  return (
    <span className="block px-[0.85em] pt-[0.6em] pb-[0.55em]">
      <span className="flex min-w-0 items-center gap-[0.55em]">
        <span
          className={cn(
            "grid size-[1.85em] shrink-0 place-items-center rounded-[0.5em]",
            planned
              ? "border border-dashed border-muted-foreground/50 text-muted-foreground"
              : "bg-kind-computing-unit/15 text-kind-computing-unit"
          )}>
          <Cpu className="size-[1.05em]" />
        </span>
        <span className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-[0.45em]">
            <span
              className={cn("truncate text-[0.95em] font-semibold", planned && "text-muted-foreground")}
              title={name}>
              {name}
            </span>
            {n?.made && <span className="size-[0.55em] shrink-0 rounded-full bg-primary" title="Made in this chat" />}
          </span>
          {level !== "overview" && (
            <span className="flex min-w-0 items-center gap-[0.35em] text-[0.82em] text-muted-foreground">
              {planned ? (
                <PlanPill title={unit.planned?.detail}>
                  planned{unit.planned?.detail ? `: ${unit.planned.detail}` : ""}
                </PlanPill>
              ) : (
                <>
                  {state && (
                    <span
                      className={cn(
                        "size-[0.55em] shrink-0 rounded-full",
                        state === "ready"
                          ? "bg-success"
                          : state === "failed"
                            ? "bg-destructive"
                            : "animate-pulse bg-primary"
                      )}
                    />
                  )}
                  <span className="truncate">
                    {[state ? `${state}${starting ? "…" : ""}` : "", n?.made ? "made here" : ""]
                      .filter(Boolean)
                      .join(" · ") || "computing unit"}
                  </span>
                </>
              )}
            </span>
          )}
        </span>
      </span>
      {empty && level !== "overview" && (
        <span className="mt-[0.5em] block pl-[2.4em] text-[0.82em] text-muted-foreground">
          Nothing has run here yet.
        </span>
      )}
    </span>
  );
}
