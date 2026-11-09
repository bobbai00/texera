// An operator on the canvas: a card. It says what the operator is and how it is set, in one
// line or with each setting on a line of its own, as the viewer chooses; it opens to edit the
// settings in place. Two buttons are the operator's own: the eye keeps its result on every run,
// and the run button runs up to it. In an execution the card says where the operator stands
// and the rows it read and put out, and the ports whose result is kept are lit.

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  cn,
  DropdownMenuItem,
  formatNumber,
  Skeleton,
  Tooltip,
} from "@texera/ui";
import {
  deleteOperators,
  describeProperties,
  type OperatorNode as OperatorNodeType,
  type OperatorStatus,
  operatorImage,
  type PropertyLine,
  RESOURCE_HANDLE,
  summarize,
  updateOperator,
} from "@texera/workflow-model";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  Clock,
  Eye,
  EyeOff,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Power,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { memo, type ReactElement, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { UriChip } from "../shell/Chips";
import { useNamed } from "../shell/RanOn";
import { toneOf } from "./Cursors";
import { type Canvas, useCanvas } from "./canvas-view";
import type { EditorStore } from "./editor";
import { PropertyForm } from "./PropertyForm";
import { ResourceChip } from "./ResourceNode";

/** Where a port's handle sits on the card's side: beside the name, one under the other. */
const HANDLE_TOP = 28;
const HANDLE_STEP = 22;

const STATUS: Record<OperatorStatus, { word: string; icon: typeof Check; tone: string; card: string }> = {
  waiting: { word: "Waiting", icon: Clock, tone: "text-muted-foreground", card: "" },
  running: {
    word: "Running",
    icon: Loader2,
    tone: "text-primary",
    card: "border-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_16%,transparent)]",
  },
  paused: { word: "Paused", icon: Pause, tone: "text-warning", card: "border-warning" },
  completed: { word: "Done", icon: Check, tone: "text-success", card: "" },
  failed: { word: "Failed", icon: X, tone: "text-destructive", card: "border-destructive" },
  stopped: { word: "Stopped", icon: Square, tone: "text-muted-foreground", card: "" },
};

/** The operator's name on its card: the one a person gave it, else its type's own. */
function titleOf(data: OperatorNodeType["data"], friendly: string | undefined): string {
  const named = data.label !== data.operatorType && data.label !== "Custom operator";
  return named ? data.label : (friendly ?? data.label);
}

/** An operator as its canvas shows it: a card, or in a small picture of a workflow its icon. */
export const OperatorNode = memo(function OperatorNode(props: NodeProps<OperatorNodeType>) {
  const canvas = useCanvas();
  if (canvas.picture)
    return (
      <Icon
        data={props.data}
        title={titleOf(props.data, canvas.schemas?.get(props.data.operatorType)?.userFriendlyName)}
      />
    );
  return <Card {...props} canvas={canvas} />;
});

function Card({ id, data, selected, canvas }: NodeProps<OperatorNodeType> & { canvas: Canvas }) {
  const detailed = useStore(canvas.view, s => s.density === "detailed");
  const editing = useStore(canvas.view, s => s.editing === id);
  const shown = useStore(canvas.view, s =>
    s.result?.startsWith(`${id}:`) ? s.result.slice(id.length + 1) : undefined
  );
  const readonly = useStore(canvas.editor ?? NO_EDITOR, s => s.readonly);
  // A result pointed at in the results window points out the card it came from.
  const pointed = useStore(canvas.view, s => s.pointed === id);
  const schema = canvas.schemas?.get(data.operatorType);
  const lines = useMemo(
    () => (schema ? describeProperties(schema.jsonSchema, data.properties) : []),
    [schema, data.properties]
  );
  // Someone else holds it: to this person the card is as to someone who may only read.
  const heldBy = canvas.heldBy?.get(id);
  const editor = readonly || heldBy ? undefined : canvas.editor;
  const title = titleOf(data, schema?.userFriendlyName);
  // Under the name: the settings in one line; with each on its own line below, the type instead.
  const named = useNamed(lines.find(l => l.short.startsWith("texera://"))?.short);
  const under =
    editing || detailed
      ? title === schema?.userFriendlyName
        ? ""
        : (schema?.userFriendlyName ?? "")
      : summarize(lines.map(l => (l.short.startsWith("texera://") ? { ...l, short: named } : l)));
  const ports = Math.max(data.inputs.length, data.outputs.length);
  // Just arrived from elsewhere (the agent, another person): pointed out for a moment.
  const arrived = canvas.arrived?.has(id) === true;

  const card = (
    <div
      className={cn(
        "group relative rounded-xl border bg-card text-card-foreground shadow-sm transition-[box-shadow,border-color]",
        // Open, it stays within its column: the cards beside it and the arrows between are not covered.
        editing ? "w-74 shadow-lg" : "w-62",
        data.disabled && "border-dashed",
        data.status && STATUS[data.status].card,
        data.error && !data.status && "border-destructive/60",
        selected && !shown && "border-primary ring-2 ring-primary/25",
        // The card whose result is on screen.
        shown !== undefined && "border-primary ring-2 ring-primary/60",
        arrived && "ring-4 ring-primary/40 animate-pulse",
        pointed && "border-primary ring-4 ring-primary/35"
      )}
      style={{
        minHeight: HANDLE_TOP * 2 + Math.max(0, ports - 1) * HANDLE_STEP,
        ...(heldBy ? { borderColor: toneOf(heldBy.pid) } : {}),
      }}
      data-selected={selected ? "true" : "false"}
      data-operator-type={data.operatorType}
      data-operator-status={data.status ?? ""}
      data-operator-view={editing ? "editing" : detailed ? "detailed" : "compact"}
      data-result-shown={shown ?? ""}
      data-pointed={pointed ? "true" : undefined}
      data-arrived={arrived ? "true" : undefined}>
      {heldBy && (
        <span
          className="absolute -top-2.5 right-3 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white shadow-xs"
          style={{ background: toneOf(heldBy.pid) }}
          title={`${heldBy.name} has this. You can look at it, not change it.`}
          data-held-by={heldBy.name}
          data-held-doing={heldBy.doing}>
          {heldBy.name} is {heldBy.doing}
        </span>
      )}
      {editing && editor ? (
        <Editor id={id} editor={editor} canvas={canvas} data={data} />
      ) : (
        <>
          <div className={cn("flex items-center gap-2.5 px-3 py-2.5", data.disabled && "opacity-60")}>
            <OperatorIcon type={data.operatorType} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm leading-5 font-medium" title={title}>
                  {title}
                </span>
                {data.disabled && (
                  <span className="shrink-0 rounded border px-1 text-xs text-muted-foreground">Off</span>
                )}
              </div>
              {under && (
                <div className="truncate text-xs text-muted-foreground" title={under} data-operator-summary>
                  {under}
                </div>
              )}
            </div>
            <Actions id={id} data={data} canvas={canvas} editor={editor} />
          </div>
          {/* Someone else's card, picked: its settings to read, since its form is theirs. */}
          {(detailed || (selected && heldBy)) && lines.length > 0 && <Settings lines={lines} />}
        </>
      )}
      {data.error && (
        <p
          className="flex items-start gap-1.5 border-t border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
          title={data.error}
          data-operator-error>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className={cn("min-w-0 [overflow-wrap:anywhere]", !editing && "line-clamp-2")}>{data.error}</span>
        </p>
      )}
      {data.status && <Progress status={data.status} rowsIn={data.rowsIn} rowsOut={data.rowsOut} />}
      {data.reusedFrom && (
        // Its rows were read from an earlier run of the same work, which the chip opens.
        <p
          className="flex min-w-0 items-center gap-1.5 border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
          data-operator-reused={data.reusedFrom}>
          <History className="size-3.5 shrink-0" />
          <span className="shrink-0">Read from</span>
          <UriChip uri={data.reusedFrom} className="min-w-0" />
        </p>
      )}
      {data.skipped && (
        <p className="border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground" data-operator-skipped>
          Not run: only results read from an earlier run needed it
        </p>
      )}
      {/* Where the line from a dataset or model this operator names ends. */}
      <Handle
        id={RESOURCE_HANDLE}
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
      {data.inputs.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="target"
          position={Position.Left}
          style={{ top: HANDLE_TOP + i * HANDLE_STEP }}
          className="!size-3 !border-2 !border-card !bg-edge"
          title={p.label}
        />
      ))}
      {data.outputs.map((p, i) => {
        // A port whose result is kept is lit; the one whose result is on screen, more.
        const result = shown === p.id ? "shown" : data.results?.includes(p.id) ? "kept" : "";
        return (
          <Handle
            key={p.id}
            id={p.id}
            type="source"
            position={Position.Right}
            style={{ top: HANDLE_TOP + i * HANDLE_STEP }}
            className={cn(
              "!border-2 !border-card",
              result === "shown"
                ? "!size-3.5 !bg-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_30%,transparent)]"
                : result === "kept"
                  ? "!size-3 !bg-primary"
                  : "!size-3 !bg-edge"
            )}
            title={result ? `${p.label ?? "Result"}: kept` : p.label}
            data-result={result}
          />
        );
      })}
    </div>
  );
  return editor ? <Menu id={id} disabled={data.disabled === true} editor={editor} card={card} /> : card;
}

/**
 * The operator's own buttons: the eye, which keeps its result on every run, and a run up to
 * it. The eye stays in sight while it is on; the rest show when the card is pointed at or picked.
 */
function Actions({
  id,
  data,
  canvas,
  editor,
  editing = false,
}: {
  id: string;
  data: OperatorNodeType["data"];
  canvas: Canvas;
  editor?: EditorStore;
  editing?: boolean;
}) {
  const keeps = data.keepsResult;
  // Shown only when the card is pointed at, picked or focused: until then they take no room
  // from the operator's name.
  const onDemand =
    "hidden group-hover:inline-flex group-focus-within:inline-flex group-data-[selected=true]:inline-flex";
  if (!editor)
    return keeps ? (
      <Eye className="size-3.5 shrink-0 text-primary" aria-label="Its result is kept" data-operator-eye="on" />
    ) : null;
  return (
    <div className="nodrag flex shrink-0 items-center">
      {canvas.run && !data.disabled && (
        <Tooltip content="Run up to here, and show its result">
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(!editing && onDemand)}
            aria-label="Run up to here"
            onClick={() => canvas.run?.(id)}
            data-operator-run>
            <Play />
          </Button>
        </Tooltip>
      )}
      <Tooltip content={keeps ? "Its result is kept on every run" : "Keep its result on every run"}>
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn(keeps ? "text-primary" : cn("text-muted-foreground", !editing && onDemand))}
          aria-label={keeps ? "Stop keeping its result" : "Keep its result"}
          aria-pressed={keeps}
          onClick={() => editor.getState().edit(s => updateOperator(s, id, o => ({ ...o, viewResult: !o.viewResult })))}
          data-operator-eye={keeps ? "on" : "off"}>
          {keeps ? <Eye /> : <EyeOff />}
        </Button>
      </Tooltip>
      {!editing && (
        <Tooltip content="Edit its settings here">
          <Button
            variant="ghost"
            size="icon-xs"
            className={onDemand}
            aria-label="Edit operator"
            onClick={() => canvas.view.getState().edit(id)}
            data-operator-edit>
            <Pencil />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

/** What else can be done to an operator, on a right click: turn it off or on, delete it. */
function Menu({
  id,
  disabled,
  editor,
  card,
}: {
  id: string;
  disabled: boolean;
  editor: EditorStore;
  card: ReactElement;
}) {
  const { edit, select } = editor.getState();
  return (
    <ContextMenu>
      <ContextMenuTrigger>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem
          onClick={() => edit(s => updateOperator(s, id, o => ({ ...o, isDisabled: !o.isDisabled })))}
          data-operator-menu="power">
          <Power /> {disabled ? "Turn on" : "Turn off"}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive"
          onClick={() => {
            select(null);
            edit(s => deleteOperators(s, [id]));
          }}
          data-operator-menu="delete">
          <Trash2 /> Delete
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Where the operator stands in the execution on screen: waiting is quiet; running is plain to
 * see, a bar moving along the card's edge while the rows it read and put out count up.
 */
function Progress({ status, rowsIn, rowsOut }: { status: OperatorStatus; rowsIn?: number; rowsOut?: number }) {
  const { word, icon: StatusIcon, tone } = STATUS[status];
  // An operator that reads nothing (a source) says what it put out; any other, what it read too.
  const rows =
    rowsOut === undefined
      ? undefined
      : rowsIn
        ? `${formatNumber(rowsIn)} → ${formatNumber(rowsOut)} ${rowsOut === 1 ? "row" : "rows"}`
        : `${formatNumber(rowsOut)} ${rowsOut === 1 ? "row" : "rows"}`;
  return (
    <div
      className="relative flex items-center gap-1.5 overflow-hidden rounded-b-xl border-t bg-muted/40 px-3 py-1.5 text-xs"
      data-operator-execution>
      <StatusIcon className={cn("size-3.5 shrink-0", tone, status === "running" && "animate-spin")} />
      <span className={cn("font-medium", tone)}>{word}</span>
      {rows && (
        <span className="ml-auto text-muted-foreground tabular-nums" data-operator-rows>
          {rows}
        </span>
      )}
      {status === "running" && (
        <span
          className="absolute bottom-0 left-0 h-0.5 w-1/3 animate-working rounded-full bg-primary"
          data-operator-working
        />
      )}
    </div>
  );
}

/**
 * An operator in a small picture of a workflow: its icon with its name under it. A picture
 * shows the shape of a workflow at a glance, where a card's words would be too small to read.
 */
function Icon({ data, title }: { data: OperatorNodeType["data"]; title: string }) {
  const top = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <div
      className="relative flex w-14 flex-col items-center"
      data-operator-type={data.operatorType}
      data-operator-view="icon">
      <div
        className={cn(
          // Operator icons are dark glyphs drawn for a white ground, so the tile stays white in dark mode too.
          "relative size-14 rounded-xl border bg-white p-2.5 shadow-sm dark:border-white/15",
          data.disabled && "border-dashed opacity-60",
          data.status === "running" && "border-primary",
          data.status === "completed" && "border-success",
          (data.status === "failed" || data.error) && "border-destructive"
        )}>
        <img
          src={operatorImage(data.operatorType)}
          alt=""
          className="size-full object-contain"
          draggable={false}
          loading="lazy"
        />
        {data.inputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="target"
            position={Position.Left}
            style={{ top: top(i, data.inputs.length) }}
            className="!size-2.5 !border-2 !border-background !bg-edge"
          />
        ))}
        {data.outputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="source"
            position={Position.Right}
            style={{ top: top(i, data.outputs.length) }}
            className="!size-2.5 !border-2 !border-background !bg-edge"
          />
        ))}
      </div>
      <div className="pointer-events-none absolute top-full mt-1.5 w-36 text-center text-sm leading-tight font-medium">
        {title}
      </div>
    </div>
  );
}

/** A store that says nothing can be edited, for a canvas that shows a workflow without an editor. */
const NO_EDITOR = {
  getState: () => ({ readonly: true }),
  getInitialState: () => ({ readonly: true }),
  subscribe: () => () => undefined,
  setState: () => undefined,
} as unknown as EditorStore;

function OperatorIcon({ type }: { type: string }) {
  return (
    // Operator icons are dark glyphs drawn for a white ground, so the tile stays white in dark mode too.
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-white p-1.5 dark:border-white/15">
      <img
        src={operatorImage(type)}
        alt=""
        className="size-full object-contain"
        draggable={false}
        loading="lazy"
        // A type with no picture of its own shows Python's rather than a broken image.
        onError={e => {
          const img = e.currentTarget;
          if (!img.src.endsWith("/PythonUDFV2.png")) img.src = "/operator-images/PythonUDFV2.png";
        }}
      />
    </span>
  );
}

/** Every setting that says something, each on a line: its name and what it is set to. */
function Settings({ lines }: { lines: PropertyLine[] }) {
  return (
    <dl className="space-y-1 border-t px-3 py-2 text-xs" data-operator-settings>
      {lines.map(line => (
        <div key={line.key} className="flex gap-2">
          <dt className="w-24 shrink-0 truncate text-muted-foreground" title={line.label}>
            {line.label}
          </dt>
          <dd className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]" title={line.value}>
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The operator open in its card: its name and its settings as a form, with the operator's own
 * buttons beside the name. Every change goes into the workflow as it is made; closing the card
 * saves nothing more.
 */
function Editor({
  id,
  editor,
  canvas,
  data,
}: {
  id: string;
  editor: EditorStore;
  canvas: Canvas;
  data: OperatorNodeType["data"];
}) {
  const operator = useStore(editor, s => s.spec.operators.find(o => o.operatorID === id));
  const box = useRef<HTMLDivElement>(null);
  // An open card takes the keyboard, so a key pressed in it is the card's: Backspace deletes a
  // character, never the operator. A card just made puts it in its first setting, to be set.
  // A card is drawn hidden until the canvas has measured it, and hidden things take no focus,
  // so this tries again for a few frames until the card has it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the card opens
  useEffect(() => {
    const fresh = canvas.view.getState().fresh;
    let frame = 0;
    const take = (tries: number) => {
      const card = box.current;
      if (!card || card.contains(document.activeElement)) return;
      const field = fresh
        ? card.querySelector<HTMLElement>("form input:not([type=checkbox]), form textarea, form select")
        : null;
      (field ?? card).focus({ preventScroll: true });
      if (!card.contains(document.activeElement) && tries > 0) frame = requestAnimationFrame(() => take(tries - 1));
    };
    take(20);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!operator) return null;
  const schema = canvas.schemas?.get(operator.operatorType);
  const { edit } = editor.getState();
  return (
    // Typing, selecting, scrolling and keys inside the form are the form's, not the canvas's.
    <div
      ref={box}
      tabIndex={-1}
      className="nodrag nopan nowheel nokey cursor-default outline-none"
      data-operator-editor={operator.operatorType}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <OperatorIcon type={operator.operatorType} />
        <div className="min-w-0 flex-1">
          <input
            aria-label="Operator name"
            value={operator.customDisplayName ?? ""}
            placeholder={schema?.userFriendlyName}
            onChange={e => edit(s => updateOperator(s, id, o => ({ ...o, customDisplayName: e.target.value })))}
            className="block w-full truncate rounded bg-transparent text-sm font-medium outline-none focus:bg-accent/50"
          />
          {operator.customDisplayName && (
            <div className="truncate text-xs text-muted-foreground">
              {schema?.userFriendlyName ?? operator.operatorType}
            </div>
          )}
        </div>
        <Actions id={id} data={data} canvas={canvas} editor={editor} editing />
      </div>
      <form className="scrollbar-thin max-h-96 overflow-y-auto p-3" onSubmit={e => e.preventDefault()}>
        {schema ? (
          <PropertyForm
            schema={schema.jsonSchema}
            values={operator.operatorProperties}
            inputs={canvas.compilation?.inputs[id] ?? []}
            onChange={values => edit(s => updateOperator(s, id, o => ({ ...o, operatorProperties: values })))}
          />
        ) : (
          <Skeleton className="h-32" />
        )}
      </form>
      <div className="flex justify-end border-t px-3 py-2">
        <Button size="sm" onClick={() => canvas.view.getState().edit(null)} data-operator-done>
          <Check /> Done
        </Button>
      </div>
    </div>
  );
}

export const nodeTypes = { operator: OperatorNode, resource: ResourceChip };
