// The things a lineage graph draws, each sized in ems of the drawing's type, so a zoom level
// sets their scale with one font size. A dataset is a capsule, a model a rounded box, a workflow
// a card (the one strong thing on the graph), a function a chip on the workflow version that
// calls it, an execution a box with the unit it ran on at its bottom right, and a result a small
// tile. Zoomed in, a box lists the versions of it that took part, each a row its arrows meet;
// a row opens that version. Dashed means not happened: named and not read, or planned. A click
// goes into the thing; the speech bubble that shows on hover comments on it, in the chat.

import type { GraphUnit, Origin, PlannedItem } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import {
  Blocks,
  Box,
  CheckCircle2,
  Circle,
  Cpu,
  Database,
  Loader2,
  Lock,
  MessageSquare,
  PauseCircle,
  Table2,
  Workflow,
  XCircle,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { unitSizeLabel } from "../kinds/profiles";
import { MadeBy } from "../shell/Chips";
import { useRanOn } from "../shell/RanOn";
import {
  type BoxItem,
  type Call,
  callsOf,
  type GraphView,
  isGoing,
  type Level,
  nameOf,
  type ResultItem,
  type RowItem,
  type RunItem,
  type RunState,
  runStateOf,
} from "./model";

/** What a pointer or a key does to a drawn thing: a click goes into it, a hover lights what it touches. */
export interface Handlers {
  onOpen: (id: string, from: HTMLElement) => void;
  onHover: (id: string | undefined) => void;
  /** Opens the comment box on a thing; absent for someone who may only read the chat. */
  onComment?: (id: string, from: HTMLElement) => void;
}

/** How everything is drawn at once: the level, what is lit, whose page or chat it is. */
export interface Drawing {
  level: Level;
  view: GraphView;
  h: Handlers;
  /** What the pointer is on. */
  hot?: string;
  /** Beside a chat: what the chat made is marked with a dot, not said. */
  chat: boolean;
  /** On a resource's page: the box or execution it is of, and the row of the version on screen. */
  root?: string;
  rootRow?: string;
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

/** The speech bubble on a thing, shown while the pointer is on it: a comment goes to the chat. */
function CommentButton({ id, h, of = "node" }: { id: string; h: Handlers; of?: "node" | "unit" }) {
  if (!h.onComment) return null;
  return (
    <button
      type="button"
      aria-label="Comment on this"
      title="Comment on this"
      data-graph-comment={id}
      onClick={e => {
        e.stopPropagation();
        h.onComment?.(id, e.currentTarget);
      }}
      onKeyDown={e => e.stopPropagation()}
      className={cn(
        "absolute top-[0.3em] right-[0.3em] z-10 grid size-[1.8em] place-items-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-foreground focus-visible:opacity-100",
        of === "node" ? "group-hover/node:opacity-100" : "group-hover/unit:opacity-100"
      )}>
      <MessageSquare className="size-[1em]" />
    </button>
  );
}

/** What makes a drawn thing a target: a click or Enter goes into it, a hover lights what it touches. */
function pick(id: string, label: string, h: Handlers) {
  return {
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

/** Props a box shares: what it is for tests and screen readers, and where its size is measured. */
function nodeProps(id: string, label: string, h: Handlers, open = true) {
  return {
    "data-graph-node": id,
    "data-graph-measure": id,
    ...(open
      ? pick(id, label, h)
      : { "aria-label": label, onPointerEnter: () => h.onHover(id), onPointerLeave: () => h.onHover(undefined) }),
  } as const;
}

/** Who made a version or started an execution: a dot when it was this chat, else a line that says who. */
function Maker({ d, createdBy, origin, made }: { d: Drawing; createdBy?: string; origin?: Origin; made: boolean }) {
  if (d.chat && made) return null;
  if (!createdBy) return null;
  return (
    // The chat it names opens on its own; the box under it does not hear the click.
    // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the box from hearing the link's click
    <span className="min-w-0" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <MadeBy createdBy={createdBy} origin={origin} className="text-[0.82em] text-muted-foreground" />
    </span>
  );
}

const LOOK = {
  data: {
    Icon: Database,
    tone: "text-kind-dataset",
    soft: "bg-kind-dataset/15",
    border: "border-kind-dataset/35",
    label: "Dataset",
  },
  model: {
    Icon: Box,
    tone: "text-kind-model",
    soft: "bg-kind-model/15",
    border: "border-kind-model/35",
    label: "Model",
  },
} as const;

/** A dataset or a model: zoomed out its name and newest version; zoomed in a row for each version of it. */
export function ResourceCard({
  box,
  d,
  className,
  style,
}: {
  box: BoxItem;
  d: Drawing;
  className?: string;
  style?: CSSProperties;
}) {
  const role = box.role === "model" ? "model" : "data";
  const look = LOOK[role];
  const n = box.node;
  const readable = n?.readable !== false;
  const name = readable ? (n?.name ?? box.planned?.name ?? "") : "Not shared with you";
  const rows = box.rows.map(id => d.view.rows.get(id) as RowItem);
  const newest = rows[0];
  const isRoot = d.root === box.id;
  const meta = [look.label, newest ? `v${newest.vno}` : "", newest?.version.files?.join(", ") ?? ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      {...nodeProps(box.id, `${look.label} ${name}`, d.h, readable)}
      data-graph-role={role}
      data-graph-readable={readable ? undefined : "false"}
      data-graph-root={isRoot ? "true" : undefined}
      style={style}
      className={cn(
        "group/node absolute w-[13em] border bg-card shadow-xs",
        d.level === "resources" ? (role === "data" ? "rounded-[1.6em]" : "rounded-[0.9em]") : "rounded-[1em]",
        readable ? look.border : "border-dashed border-muted-foreground/40",
        isRoot && "border-primary ring-4 ring-primary/15",
        className
      )}>
      {n?.made && <MadeDot className="top-[0.85em] right-[0.7em]" />}
      {readable && <CommentButton id={box.id} h={d.h} />}
      <div className="flex items-center gap-[0.6em] py-[0.45em] pr-[1.5em] pl-[0.45em]">
        <span
          className={cn(
            "grid size-[2.2em] shrink-0 place-items-center",
            role === "data" ? "rounded-full" : "rounded-[0.6em]",
            readable ? cn(look.soft, look.tone) : "bg-muted text-muted-foreground"
          )}>
          {readable ? <look.Icon className="size-[1.15em]" /> : <Lock className="size-[1em]" />}
        </span>
        <div className="grid min-w-0">
          <span
            className={cn("line-clamp-2 leading-[1.25] font-semibold", !readable && "text-muted-foreground")}
            title={name}>
            {name}
          </span>
          <span className="truncate text-[0.86em] text-muted-foreground">
            {d.level === "resources" ? meta : look.label}
          </span>
        </div>
      </div>
      {d.level === "versions" && rows.length > 0 && (
        <ul className="grid gap-[0.12em] border-t px-[0.45em] pt-[0.3em] pb-[0.4em]" data-graph-versions>
          {rows.map(row => (
            <VersionRow key={row.id} row={row} d={d} open={readable}>
              <span className="truncate font-mono text-[0.95em]" title={row.version.files?.join(", ")}>
                {row.version.files?.join(", ")}
              </span>
            </VersionRow>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A row of a box: one version of it. It opens that version, and its arrows meet it. */
function VersionRow({
  row,
  d,
  open,
  children,
  after,
}: {
  row: RowItem;
  d: Drawing;
  open: boolean;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const v = row.version;
  return (
    <li
      {...(open ? pick(row.id, nameOf(d.view, row.id), d.h) : {})}
      data-graph-row={row.id}
      data-graph-version={row.vno}
      data-graph-on-screen={d.rootRow === row.id ? "true" : undefined}
      className={cn(
        "relative grid gap-[0.1em] rounded-[0.45em] px-[0.4em] py-[0.25em] text-[0.86em]",
        open && "cursor-pointer hover:bg-muted/70",
        d.hot === row.id && "bg-muted",
        d.rootRow === row.id && "bg-primary/10"
      )}>
      <span className="flex min-w-0 items-center gap-[0.5em]">
        <span className="shrink-0 font-semibold tabular-nums">v{row.vno}</span>
        {d.chat && v.made && (
          <span
            className="size-[0.5em] shrink-0 rounded-full bg-primary"
            title="Made in this chat"
            data-graph-made-dot
          />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-[0.35em] text-muted-foreground">{children}</span>
        {after}
      </span>
      <Maker d={d} createdBy={v.createdBy} origin={v.origin} made={v.made} />
    </li>
  );
}

/** A result an execution kept, or a dataset the plan will make. */
export function ResultTile({
  item,
  d,
  className,
  style,
}: {
  item: ResultItem;
  d: Drawing;
  className?: string;
  style?: CSSProperties;
}) {
  const planned = !!item.planned;
  const rows = item.result?.rows ?? undefined;
  return (
    <div
      {...nodeProps(item.id, `${planned ? "Planned dataset" : "Result"} ${item.title}`, d.h)}
      data-graph-role={planned ? "planned" : "result"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-operator={item.result?.operator}
      title={item.result ? `${item.title} (${item.result.operator})` : item.title}
      style={style}
      className={cn(
        "group/node absolute flex w-[10em] items-center gap-[0.5em] rounded-[0.6em] border py-[0.4em] pr-[0.65em] pl-[0.45em]",
        planned ? "border-dashed border-muted-foreground/50 bg-transparent" : "bg-card shadow-xs",
        className
      )}>
      {!planned && <CommentButton id={item.id} h={d.h} />}
      <span
        className={cn(
          "grid size-[1.9em] shrink-0 place-items-center rounded-[0.45em]",
          planned
            ? "border border-dashed border-muted-foreground/50 text-muted-foreground"
            : "bg-kind-dataset/10 text-kind-dataset"
        )}>
        <Table2 className="size-[1em]" />
      </span>
      <div className="grid min-w-0">
        <span className={cn("truncate font-semibold", planned && "text-muted-foreground")}>{item.title}</span>
        <span className="truncate text-[0.86em] text-muted-foreground">
          {planned ? "planned" : rows !== undefined ? plural(rows, "row") : "kept"}
        </span>
      </div>
    </div>
  );
}

/** A function a workflow version calls, or a model or function the plan will make. */
function UseChip({ call, planned, d }: { call?: Call; planned?: PlannedItem; d: Drawing }) {
  const node = call?.node;
  const model = planned?.kind === "model";
  const Icon = model ? Box : Blocks;
  const name = node ? node.name || "Not shared with you" : (planned?.name ?? "");
  const id = node?.readable ? node.uri : undefined;
  return (
    <span
      {...(id ? pick(id, `Function ${name}`, d.h) : {})}
      data-graph-role={planned ? "planned" : "function"}
      data-graph-uses={node?.uri}
      data-graph-planned={planned ? "true" : undefined}
      title={`${model ? "Model" : "Function"} ${name}${call ? ` v${call.vno}` : ""}${planned ? ", planned" : ""}`}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-[0.35em] rounded-[0.45em] border py-[0.15em] pr-[0.45em] pl-[0.3em] text-[0.92em] leading-[1.25] whitespace-nowrap",
        planned
          ? "border-dashed border-muted-foreground/50 text-muted-foreground"
          : call && !call.executed
            ? "border-dashed border-kind-operator/50"
            : "border-kind-operator/30 bg-kind-operator/10",
        d.hot === node?.uri && "border-kind-operator ring-2 ring-kind-operator/30",
        id && "cursor-pointer"
      )}>
      <Icon className={cn("size-[1.05em] shrink-0", planned ? "" : model ? "text-kind-model" : "text-kind-operator")} />
      <span className="truncate text-foreground">{name}</span>
      {call && <span className="text-muted-foreground tabular-nums">v{call.vno}</span>}
    </span>
  );
}

/** A workflow: zoomed out its name, newest version and how its newest execution stands; zoomed in a row for each version, with what it calls. */
export function WorkCard({
  box,
  d,
  className,
  style,
}: {
  box: BoxItem;
  d: Drawing;
  className?: string;
  style?: CSSProperties;
}) {
  const n = box.node;
  const planned = !!box.planned;
  const readable = n?.readable !== false;
  const name = readable ? (n?.name ?? box.planned?.name ?? "") : "Not shared with you";
  const rows = box.rows.map(id => d.view.rows.get(id) as RowItem);
  const newestRun = d.view.runs.get((d.view.runsOf.get(box.id) ?? []).find(id => d.view.runs.get(id)?.run) ?? "");
  const state = newestRun?.run ? runStateOf(newestRun) : undefined;
  const look = state ? RUN_LOOK[state] : undefined;
  const runs = (d.view.runsOf.get(box.id) ?? []).filter(id => d.view.runs.get(id)?.run).length;
  const uses = d.view.plannedUses.get(box.id) ?? [];
  const calls = callsOf(d.view, box.id);
  return (
    <div
      {...nodeProps(box.id, `${planned ? "Planned workflow" : "Workflow"} ${name}`, d.h, readable)}
      data-graph-role={planned ? "planned" : "workflow"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-root={d.root === box.id ? "true" : undefined}
      style={style}
      className={cn(
        "group/node absolute overflow-hidden rounded-[0.95em] border bg-card",
        d.level === "resources" ? "w-[15em]" : "w-[17.5em]",
        planned
          ? "border-dashed border-muted-foreground/50 bg-transparent"
          : "border-kind-workflow/45 shadow-[0_1px_2px_oklch(0.3_0.03_210/0.08),0_8px_22px_-10px_color-mix(in_oklch,var(--kind-workflow)_55%,transparent)]",
        d.root === box.id && "border-primary ring-4 ring-primary/15",
        className
      )}>
      {n?.made && <MadeDot className="top-[0.75em] right-[0.7em]" />}
      {!planned && readable && <CommentButton id={box.id} h={d.h} />}
      <div className="flex items-start gap-[0.6em] pt-[0.7em] pr-[1.5em] pb-[0.55em] pl-[0.8em]">
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
            className={cn("line-clamp-2 leading-[1.25] font-semibold", planned && "text-muted-foreground")}
            title={name}>
            {name}
          </span>
          <span className="truncate text-[0.86em] text-muted-foreground">
            {planned
              ? (box.planned?.detail ?? "Planned")
              : d.level === "resources"
                ? `Workflow${rows[0] ? ` · v${rows[0].vno}` : ""}`
                : "Workflow"}
          </span>
          {d.level === "resources" && look && (
            // How its newest execution stands, and how many it had.
            <span
              className="flex min-w-0 items-center gap-[0.3em] text-[0.86em] text-muted-foreground"
              data-graph-state={state}>
              <look.Icon
                className={cn("size-[1em] shrink-0", look.tone, state && isGoing(state) && "animate-spin")}
                aria-hidden
              />
              <span className="truncate" title={look.word}>
                {runs > 1 ? plural(runs, "execution") : look.word}
              </span>
            </span>
          )}
        </div>
      </div>
      {d.level === "resources" && (calls.length > 0 || uses.length > 0) && (
        <div
          className="flex flex-wrap items-center gap-[0.35em] border-t bg-muted/40 px-[0.8em] pt-[0.45em] pb-[0.6em]"
          data-graph-uses-row>
          {calls.map(c => (
            <UseChip key={c.node.uri} call={c} d={d} />
          ))}
          {uses.map(p => (
            <UseChip key={`${p.kind}:${p.name}`} planned={p} d={d} />
          ))}
        </div>
      )}
      {d.level === "versions" && (rows.length > 0 || uses.length > 0) && (
        <ul className="grid gap-[0.12em] border-t px-[0.45em] pt-[0.3em] pb-[0.4em]" data-graph-versions>
          {rows.map(row => (
            <VersionRow
              key={row.id}
              row={row}
              d={d}
              open={readable}
              after={
                row.earlier > 0 ? (
                  <span className="shrink-0 text-muted-foreground" data-graph-earlier={row.earlier}>
                    +{row.earlier} earlier
                  </span>
                ) : row.runs.length === 0 ? (
                  <span className="shrink-0 text-muted-foreground/80">not executed</span>
                ) : undefined
              }>
              {row.calls.length > 0 && (
                <span className="flex min-w-0 flex-wrap gap-[0.3em]">
                  {row.calls.map(c => (
                    <UseChip key={c.node.uri} call={c} d={d} />
                  ))}
                </span>
              )}
            </VersionRow>
          ))}
          {uses.length > 0 && (
            <li className="flex flex-wrap gap-[0.3em] px-[0.4em] py-[0.25em] text-[0.86em]">
              {uses.map(p => (
                <UseChip key={`${p.kind}:${p.name}`} planned={p} d={d} />
              ))}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** How an execution stands, in a word and an icon. */
const RUN_LOOK: Record<RunState, { word: string; Icon: typeof Circle; tone: string }> = {
  completed: { word: "Completed", Icon: CheckCircle2, tone: "text-success" },
  running: { word: "Running", Icon: Loader2, tone: "text-kind-execution" },
  starting: { word: "Starting", Icon: Loader2, tone: "text-kind-execution" },
  paused: { word: "Paused", Icon: PauseCircle, tone: "text-muted-foreground" },
  failed: { word: "Failed", Icon: XCircle, tone: "text-destructive" },
  cancelled: { word: "Cancelled", Icon: XCircle, tone: "text-destructive" },
  planned: { word: "Planned", Icon: Circle, tone: "text-muted-foreground" },
  waiting: { word: "Not executed yet", Icon: Circle, tone: "text-muted-foreground/70" },
};

const seconds = (from?: string, to?: string) =>
  from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)} s` : "";

/** An execution: how it stands, the version it ran and how long it took, the unit it ran on at its bottom right. */
export function RunBox({
  item,
  d,
  className,
  style,
}: {
  item: RunItem;
  d: Drawing;
  className?: string;
  style?: CSSProperties;
}) {
  const state = runStateOf(item);
  const look = RUN_LOOK[state];
  const going = isGoing(state);
  const run = item.run;
  const planned = !run;
  const took = run ? seconds(run.startedAt, run.finishedAt) : "";
  const facts = run
    ? [plural(run.steps, "step"), run.reused > 0 ? `${run.reused} reused` : ""].filter(Boolean).join(" · ")
    : "";
  const on = run?.unit ?? item.willRunOn;
  // Where it ran and kept its results is said in full on hover: the unit, the profile it was
  // made from, the warehouse.
  const ran = useRanOn({ unit: run?.unit?.uri, profile: run?.profile, warehouse: run?.warehouse }).said;
  const label = `${look.word}${run ? ` v${run.version}` : ""}${on ? ` on ${on.name}` : ""}`;
  return (
    <div
      {...nodeProps(item.id, `Execution: ${label}`, d.h)}
      data-graph-role={planned ? "planned" : "run"}
      data-graph-planned={planned ? "true" : undefined}
      data-graph-state={state}
      data-graph-of={item.work}
      data-graph-ran={run?.version}
      data-graph-root={d.root === item.id ? "true" : undefined}
      title={
        item.planned ? `${label}; ${item.planned.name}` : run && ran ? `${look.word} v${run.version} ${ran}` : label
      }
      data-graph-ran-on={ran || undefined}
      style={style}
      className={cn(
        "group/node absolute flex w-[13em] flex-col overflow-hidden rounded-[0.95em] border",
        planned
          ? "border-dashed border-muted-foreground/50 bg-background text-muted-foreground"
          : "border-kind-execution/60 bg-[color-mix(in_oklch,var(--kind-execution)_8%,var(--card))] shadow-xs",
        d.root === item.id && "border-primary ring-4 ring-primary/15",
        className
      )}>
      {run && <CommentButton id={item.id} h={d.h} />}
      <div className="flex h-[2.4em] shrink-0 items-center gap-[0.45em] pr-[0.75em] pl-[0.6em]">
        <look.Icon className={cn("size-[1.15em] shrink-0", look.tone, going && "animate-spin")} aria-hidden />
        <span className={cn("truncate text-[0.92em]", planned ? "font-medium" : "font-semibold")}>{look.word}</span>
        {run && (
          <span className="ml-auto shrink-0 text-[0.82em] text-muted-foreground tabular-nums">
            {[`v${run.version}`, took].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      {(facts || run) && (
        <div className="grid gap-[0.15em] px-[0.75em] pb-[0.35em] text-[0.8em] text-muted-foreground tabular-nums">
          {facts && <span className="truncate">{facts}</span>}
          {run && <Maker d={d} createdBy={run.createdBy} origin={run.origin} made={run.made} />}
        </div>
      )}
      {(run?.unit || item.willRunOn || item.plannedUnit) && (
        <div className="mt-auto flex justify-end px-[0.4em] pb-[0.4em]">
          <UnitLabel unit={run?.unit ?? item.willRunOn} planned={item.plannedUnit} h={d.h} />
        </div>
      )}
      {going && (
        <div className="absolute inset-x-0 bottom-0 h-[0.18em] overflow-hidden bg-kind-execution/15">
          <div className="absolute inset-y-0 w-1/3 animate-working bg-kind-execution" />
        </div>
      )}
    </div>
  );
}

/** The unit an execution ran on, said on it: its name, how it stands and what it has; it opens the unit. */
function UnitLabel({ unit, planned, h }: { unit?: GraphUnit; planned?: PlannedItem; h: Handlers }) {
  const name = unit?.name ?? planned?.name ?? "";
  const size = unit
    ? unitSizeLabel({ cpu: unit.cpu ?? undefined, memory: unit.memory ?? undefined, gpu: unit.gpu ?? undefined })
    : "";
  return (
    <span
      {...(unit ? pick(unit.uri, `Computing unit ${name}`, h) : {})}
      data-graph-role={unit ? "unit" : "planned"}
      data-graph-unit={unit?.uri}
      className={cn(
        "group/unit flex max-w-full items-center gap-[0.45em] rounded-[0.6em] border py-[0.3em] pr-[0.7em] pl-[0.35em]",
        unit
          ? "cursor-pointer border-kind-computing-unit/40 bg-[color-mix(in_oklch,var(--kind-computing-unit)_9%,var(--card))]"
          : "border-dashed border-muted-foreground/50 bg-background"
      )}>
      <span
        className={cn(
          "grid size-[1.7em] shrink-0 place-items-center rounded-[0.4em]",
          unit
            ? "bg-kind-computing-unit/15 text-kind-computing-unit"
            : "border border-dashed border-muted-foreground/50 text-muted-foreground"
        )}>
        <Cpu className="size-[1em]" />
      </span>
      <span className="grid min-w-0">
        <span className="flex min-w-0 items-center gap-[0.35em] text-[0.9em] leading-[1.25] font-semibold" title={name}>
          <span className={cn("truncate", !unit && "text-muted-foreground")}>{name}</span>
          {unit?.state && (
            <span
              className={cn(
                "size-[0.5em] shrink-0 rounded-full",
                unit.state === "ready"
                  ? "bg-success"
                  : unit.state === "failed"
                    ? "bg-destructive"
                    : "animate-pulse bg-primary"
              )}
              title={unit.state}
            />
          )}
        </span>
        {(size || !unit) && (
          <span className="truncate text-[0.8em] text-muted-foreground">{unit ? size : "planned"}</span>
        )}
      </span>
    </span>
  );
}
