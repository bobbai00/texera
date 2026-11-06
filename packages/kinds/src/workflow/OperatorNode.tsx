// An operator on the canvas: a card. It says what the operator is and how it is set, in one
// line or with each setting on a line of its own, as the viewer chooses; it opens to edit the
// settings in place; and it says where the operator stands in the execution on screen: its
// state, the rows it put out, and which of its results can be read.

import { Button, cn, formatNumber, Skeleton, Tooltip } from "@texera/ui";
import {
  deleteOperators,
  describeProperties,
  type OperatorNode as OperatorNodeType,
  type OperatorStatus,
  operatorImage,
  type PropertyLine,
  summarize,
  updateOperator,
} from "@texera/workflow-model";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Pause,
  Pencil,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { memo, useMemo } from "react";
import { useStore } from "zustand";
import { type Canvas, portKey, useCanvas } from "./canvas-view";
import type { EditorStore } from "./editor";
import { PropertyForm } from "./PropertyForm";

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
  const detailed = useStore(canvas.view, s => (s.density === "detailed") !== s.flipped.has(id));
  const editing = useStore(canvas.view, s => s.editing === id);
  const shown = useStore(canvas.view, s =>
    s.result?.startsWith(`${id}:`) ? s.result.slice(id.length + 1) : undefined
  );
  const readonly = useStore(canvas.editor ?? NO_EDITOR, s => s.readonly);
  const schema = canvas.schemas?.get(data.operatorType);
  const lines = useMemo(
    () => (schema ? describeProperties(schema.jsonSchema, data.properties) : []),
    [schema, data.properties]
  );
  const editable = canvas.editor !== undefined && !readonly;
  const { view } = canvas;
  const title = titleOf(data, schema?.userFriendlyName);
  // Under the name: the settings in one line; with each on its own line below, the type instead.
  const under =
    editing || detailed
      ? title === schema?.userFriendlyName
        ? ""
        : (schema?.userFriendlyName ?? "")
      : summarize(lines);
  const status = data.status ? STATUS[data.status] : undefined;
  const ports = Math.max(data.inputs.length, data.outputs.length);

  return (
    <div
      className={cn(
        "group relative rounded-xl border bg-card text-card-foreground shadow-sm transition-[box-shadow,border-color]",
        editing ? "w-88 shadow-lg" : "w-62",
        data.disabled && "border-dashed",
        status?.card,
        data.error && !status && "border-destructive/60",
        selected && !shown && "border-primary ring-2 ring-primary/25",
        // The card whose result is on screen: the line from the result's tab ends here.
        shown !== undefined && "border-primary ring-2 ring-primary/60"
      )}
      style={{ minHeight: HANDLE_TOP * 2 + Math.max(0, ports - 1) * HANDLE_STEP }}
      data-operator-type={data.operatorType}
      data-operator-status={data.status ?? ""}
      data-operator-view={editing ? "editing" : detailed ? "detailed" : "compact"}
      data-result-shown={shown ?? ""}>
      {editing && canvas.editor ? (
        <Editor id={id} editor={canvas.editor} canvas={canvas} />
      ) : (
        <>
          <div className={cn("flex items-center gap-2.5 px-3 py-2.5", data.disabled && "opacity-60")}>
            <OperatorIcon type={data.operatorType} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm leading-5 font-medium" title={title}>
                  {title}
                </span>
                {data.keepsResult && (
                  <Tooltip content="Its result is kept after an execution">
                    <Table2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="Result kept" />
                  </Tooltip>
                )}
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
            <div
              className={cn(
                "nodrag absolute top-1.5 right-1.5 flex items-center rounded-md border bg-card opacity-0 shadow-xs transition-opacity group-hover:opacity-100 focus-within:opacity-100",
                selected && "opacity-100"
              )}>
              {lines.length > 0 && (
                <Tooltip content={detailed ? "Show the settings in one line" : "Show every setting"}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={detailed ? "Show less" : "Show more"}
                    onClick={() => view.getState().flip(id)}
                    data-operator-flip>
                    {detailed ? <ChevronUp /> : <ChevronDown />}
                  </Button>
                </Tooltip>
              )}
              {editable && (
                <Tooltip content="Edit the settings here">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Edit operator"
                    onClick={() => view.getState().edit(id)}
                    data-operator-edit>
                    <Pencil />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
          {detailed && lines.length > 0 && <Settings lines={lines} />}
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
      {status && (
        <div
          className="flex items-center gap-1.5 rounded-b-xl border-t bg-muted/40 px-3 py-1.5 text-xs"
          data-operator-execution>
          <status.icon className={cn("size-3.5 shrink-0", status.tone, data.status === "running" && "animate-spin")} />
          <span className={cn("font-medium", status.tone)}>{status.word}</span>
          {data.rows !== undefined && (
            <span className="text-muted-foreground tabular-nums" data-operator-rows>
              · {formatNumber(data.rows)} {data.rows === 1 ? "row" : "rows"}
            </span>
          )}
          <span className="nodrag ml-auto flex items-center gap-1">
            {(data.results ?? []).map(port => {
              const on = shown === port;
              return (
                <button
                  key={port}
                  type="button"
                  onClick={() => view.getState().show(on ? null : portKey(id, port))}
                  aria-pressed={on}
                  title={on ? "Its result is on screen below" : "Show this result below"}
                  data-operator-result={port}
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-md px-1.5 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    on ? "bg-primary text-primary-foreground" : "text-primary hover:bg-primary/10"
                  )}>
                  <Table2 className="size-3.5" />
                  {data.outputs.length > 1 ? (data.outputs.find(o => o.id === port)?.label ?? port) : "Result"}
                </button>
              );
            })}
          </span>
        </div>
      )}
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
      {data.outputs.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="source"
          position={Position.Right}
          style={{ top: HANDLE_TOP + i * HANDLE_STEP }}
          className={cn("!size-3 !border-2 !border-card", shown === p.id ? "!bg-primary" : "!bg-edge")}
          title={p.label}
        />
      ))}
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
      <img src={operatorImage(type)} alt="" className="size-full object-contain" draggable={false} loading="lazy" />
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
 * The operator open in its card: its name, whether it runs and keeps its result, and its
 * settings as a form. Every change goes into the workflow as it is made; closing the card
 * saves nothing more.
 */
function Editor({ id, editor, canvas }: { id: string; editor: EditorStore; canvas: Canvas }) {
  const operator = useStore(editor, s => s.spec.operators.find(o => o.operatorID === id));
  if (!operator) return null;
  const schema = canvas.schemas?.get(operator.operatorType);
  const { edit, select } = editor.getState();
  const close = () => canvas.view.getState().edit(null);
  return (
    // Typing, selecting and scrolling inside the form are the form's, not the canvas's.
    <div className="nodrag nopan nowheel cursor-default" data-operator-editor={operator.operatorType}>
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
        <Tooltip
          content={
            operator.viewResult
              ? "Its result is kept: readable after the execution"
              : "Keep this operator's result after the execution"
          }>
          <Button
            variant={operator.viewResult ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={operator.viewResult ? "Stop keeping the result" : "Keep the result"}
            onClick={() => edit(s => updateOperator(s, id, o => ({ ...o, viewResult: !o.viewResult })))}>
            <Table2 />
          </Button>
        </Tooltip>
        <Tooltip
          content={
            operator.isDisabled ? "Off: left out of executions. Turn it on" : "Turn it off: leave it out of executions"
          }>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={operator.isDisabled ? "Enable operator" : "Disable operator"}
            onClick={() => edit(s => updateOperator(s, id, o => ({ ...o, isDisabled: !o.isDisabled })))}>
            {operator.isDisabled ? <EyeOff /> : <Eye />}
          </Button>
        </Tooltip>
        <Tooltip content="Delete operator">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete operator"
            onClick={() => {
              close();
              select(null);
              edit(s => deleteOperators(s, [id]));
            }}>
            <Trash2 />
          </Button>
        </Tooltip>
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
        <Button size="sm" onClick={close} data-operator-done>
          <Check /> Done
        </Button>
      </div>
    </div>
  );
}

export const nodeTypes = { operator: OperatorNode };
