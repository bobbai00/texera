// The result open on a canvas, in a window over it: the table an execution wrote for one output
// port, opened from its cylinder under the card it came out of, or from the card. It says what
// the table is (the operator and the execution, the table in the warehouse, its rows and
// columns, the version it is of when the operator changed since), shows its rows or the picture
// a visualization drew, and saves it as a version of a dataset. It is moved by its title bar,
// sized by its top right corner, folded to its title bar and left where it was put. Where there
// is no canvas (an execution whose version cannot be read, a result on the lineage graph) the
// results the execution kept are listed above the one open.

import { useQuery } from "@tanstack/react-query";
import type { Execution, PortSummary } from "@texera/catalog-client/types";
import { Badge, Button, cn, EmptyState, formatNumber, Tooltip } from "@texera/ui";
import { operatorImage } from "@texera/workflow-model";
import { ArrowUpRight, ChevronDown, ChevronUp, Cylinder, GripHorizontal, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { isChart, keptResult } from "../execution/overlay";
import { isLive } from "../execution/queries";
import { versionOf } from "../uri";
import { type CanvasView, portKey } from "../workflow/canvas-view";
import { PortResult, pageOf } from "./PortResult";
import {
  DEFAULT_PLACE,
  fitted,
  moved,
  type ResultsPlace,
  remember,
  remembered,
  resized,
  TITLE_HEIGHT,
} from "./results-window";
import { SaveResult } from "./SaveResult";

/** How a result is named: as its operator's card names it. */
export interface ResultLabel {
  title: string;
  /** What the operator does, in a few words, as its card says it. */
  summary?: string;
  /** Its type, for its icon. */
  type?: string;
}

export function ResultsWindow({
  execution,
  workflow,
  view,
  labelOf,
  staleOf,
  onOpen,
  floating = true,
}: {
  execution: Execution;
  /** The workflow the execution is of. */
  workflow: string;
  view: CanvasView;
  labelOf: (operatorID: string) => ResultLabel;
  /** The version a result is of, when its operator, or one it reads from, changed since. */
  staleOf?: (operatorID: string) => number | undefined;
  /** Opens the execution's own page; absent on that page. */
  onOpen?: () => void;
  /** A window over the canvas, or the results standing on their own. */
  floating?: boolean;
}) {
  const eid = execution.metadata.rid;
  const ports = execution.status?.resultsExpiredAt ? [] : (execution.status?.ports ?? []).filter(keptResult);
  const chosen = useStore(view, s => s.result);
  const active = ports.find(p => portKey(p.operatorID, p.portID) === chosen);
  // A card pointed out by the result open is pointed out no longer once the window is gone.
  useEffect(() => () => view.getState().point(null), [view]);
  const live = isLive(execution);
  const open = floating ? active !== undefined : true;

  const { place, box, area, title, size, fold, reset } = useWindowPlace(floating && open);
  const folded = floating && place.folded;
  // The canvas keeps the cards it brings into view clear of what the window covers.
  useEffect(() => {
    if (!floating || !area || !open) return;
    view.getState().cover({
      left: place.left,
      bottom: place.bottom,
      width: place.width,
      height: folded ? TITLE_HEIGHT : place.height,
    });
    return () => view.getState().cover(null);
  }, [floating, area, open, place.left, place.bottom, place.width, place.height, folded, view]);
  if (!open) return null;
  const label = active ? labelOf(active.operatorID) : undefined;
  const stale = active ? staleOf?.(active.operatorID) : undefined;
  const ran = versionOf(execution.spec.workflow);

  return (
    <section
      ref={box}
      className={cn(
        // Keys pressed in the window are its own: Backspace never deletes a card from here.
        "nokey flex min-h-0 flex-col bg-background",
        floating ? "absolute z-20 overflow-hidden rounded-xl border shadow-xl" : "h-full"
      )}
      style={
        floating && area
          ? { left: place.left, bottom: place.bottom, width: place.width, height: folded ? TITLE_HEIGHT : place.height }
          : undefined
      }
      aria-label="Result"
      data-results={eid}
      data-results-window={floating ? (folded ? "folded" : "open") : "page"}
      data-result-open={active ? portKey(active.operatorID, active.portID) : undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the title bar moves the window by the pointer and points out the card; its buttons are the keyboard's */}
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-2 py-1.5",
          floating && "cursor-grab select-none active:cursor-grabbing"
        )}
        style={floating ? { minHeight: TITLE_HEIGHT } : undefined}
        onPointerDown={floating ? title : undefined}
        onDoubleClick={floating ? reset : undefined}
        onPointerEnter={() => active && view.getState().point(active.operatorID)}
        onPointerLeave={() => view.getState().point(null)}
        title={floating ? "Drag to move; double-click to put it back" : undefined}
        data-results-title>
        {floating && <GripHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        {active && label ? (
          <ResultName port={active} label={label} />
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Cylinder className="size-4 shrink-0 text-primary" aria-hidden /> Results
          </span>
        )}
        {stale !== undefined && (
          <Tooltip content={`This result is of version ${stale}; the operator, or one it reads from, changed since.`}>
            <Badge tone="warning" className="shrink-0" data-result-stale={stale}>
              v{stale} · changed since
            </Badge>
          </Tooltip>
        )}
        <span className="flex-1" />
        {active && !live && label && (
          <SaveResult
            workflow={workflow}
            execution={execution}
            port={active}
            title={label.title}
            project={execution.metadata.project}
          />
        )}
        {onOpen && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onOpen}
            aria-label="Open this execution beside the workflow"
            title="Open this execution beside the workflow"
            data-open-execution>
            <ArrowUpRight />
          </Button>
        )}
        {floating && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fold}
            aria-label={folded ? "Unfold the result" : "Fold the result"}
            data-fold-results>
            {folded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
        {floating && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => view.getState().show(null)}
            aria-label="Close the result"
            data-close-result>
            <X />
          </Button>
        )}
      </header>
      {!folded && (
        <>
          {!floating && (
            <div
              className="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
              role="tablist"
              aria-label="Results by operator">
              {ports.map(port => {
                const key = portKey(port.operatorID, port.portID);
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={port === active}
                    onClick={() => view.getState().show(key)}
                    className={cn(
                      "inline-flex max-w-72 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                      port === active
                        ? "border-primary bg-primary/10"
                        : "border-transparent text-muted-foreground hover:bg-accent"
                    )}
                    data-result-pick={key}>
                    <ResultName port={port} label={labelOf(port.operatorID)} small />
                  </button>
                );
              })}
              {ports.length === 0 && (
                <span className="px-1.5 py-1 text-xs text-muted-foreground">{emptySaid(execution, live)}</span>
              )}
            </div>
          )}
          {active ? (
            <>
              <About workflow={workflow} execution={execution} port={active} live={live} ran={ran} />
              <PortResult
                key={portKey(active.operatorID, active.portID)}
                workflow={workflow}
                eid={eid}
                port={active}
                live={live}
              />
            </>
          ) : (
            ports.length > 0 && <EmptyState className="py-8">Pick a result to see its rows.</EmptyState>
          )}
        </>
      )}
      {floating && !folded && (
        // The top right corner, which faces the canvas, sizes the window.
        <span
          className="absolute top-0 right-0 size-3.5 cursor-nesw-resize"
          onPointerDown={size}
          aria-hidden
          data-results-resize
        />
      )}
    </section>
  );
}

/** Why an execution lists no result. */
const emptySaid = (execution: Execution, live: boolean) =>
  execution.status?.resultsExpiredAt
    ? "The results expired under the retention policy."
    : live
      ? "Results show here as operators finish."
      : "No result is kept: turn on an operator's eye, or run up to it.";

/** A result named as its operator's card names it: its icon, its name, its port when not the first, its rows. */
function ResultName({ port, label, small = false }: { port: PortSummary; label: ResultLabel; small?: boolean }) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5", small ? "text-xs" : "text-sm")}
      title={[label.title, label.summary].filter(Boolean).join(": ")}>
      {label.type ? (
        <img
          src={operatorImage(label.type)}
          alt=""
          className="size-4 shrink-0 rounded-sm bg-white object-contain"
          draggable={false}
        />
      ) : (
        <Cylinder className="size-4 shrink-0 text-primary" aria-hidden />
      )}
      <span className="shrink-0 font-medium">{label.title}</span>
      {!small && label.summary && <span className="min-w-0 truncate text-muted-foreground">{label.summary}</span>}
      {!port.portID.endsWith("-0") && <span className="shrink-0 text-muted-foreground">{port.portID}</span>}
    </span>
  );
}

/** What the table is: the execution that wrote it, where it is kept, its rows and columns. */
function About({
  workflow,
  execution,
  port,
  live,
  ran,
}: {
  workflow: string;
  execution: Execution;
  port: PortSummary;
  live: boolean;
  ran?: number;
}) {
  // The first page of rows, as the table under this reads it: it says the columns.
  const { data } = useQuery(pageOf(workflow, execution.metadata.rid, port, 1, live));
  const chart = data ? isChart(data.schema) : false;
  const facts = [
    `${execution.metadata.name}${ran !== undefined ? ` · v${ran}` : ""}`,
    port.table,
    port.rows !== undefined && !chart ? `${formatNumber(port.rows)} row${port.rows === 1 ? "" : "s"}` : "",
    data && !chart ? `${data.schema.length} column${data.schema.length === 1 ? "" : "s"}` : "",
    chart ? "a picture" : "",
  ].filter(Boolean);
  return (
    <p
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-3 py-1 text-xs text-muted-foreground"
      data-result-about>
      {facts.map(fact => (
        <span key={fact} className="truncate">
          {fact}
        </span>
      ))}
    </p>
  );
}

/**
 * Whether an event happened on the title bar itself. What opens from it (the form that saves a
 * result) lies in a portal elsewhere on the page, but its events still reach the bar's handlers:
 * taken for the bar's, a press in it would move the window and keep the press from the form.
 */
const onTheBar = (e: { currentTarget: Element; target: EventTarget }) => e.currentTarget.contains(e.target as Node);

/** Where a floating window is, and the pointer handlers that move, size, fold and reset it. */
function useWindowPlace(floating: boolean) {
  const box = useRef<HTMLElement>(null);
  const [kept, setKept] = useState<ResultsPlace>(remembered);
  const [area, setArea] = useState<{ width: number; height: number }>();
  const areaNow = useRef(area);
  areaNow.current = area;
  // The canvas the window floats over: it keeps to it when the canvas is sized.
  useLayoutEffect(() => {
    const parent = box.current?.parentElement;
    if (!floating || !parent) return;
    const measure = () => setArea({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(parent);
    return () => watcher.disconnect();
  }, [floating]);
  const place = area ? fitted(kept, area) : kept;
  const drag = useCallback(
    (change: (from: ResultsPlace, dx: number, dy: number) => ResultsPlace) => (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !onTheBar(e) || (e.target as HTMLElement).closest("button, a, input, [role=tab]")) return;
      const within = areaNow.current;
      if (!within) return;
      e.preventDefault();
      const from = fitted(kept, within);
      const start = { x: e.clientX, y: e.clientY };
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      let last = from;
      const onMove = (ev: PointerEvent) => {
        last = fitted(change(from, ev.clientX - start.x, ev.clientY - start.y), within);
        setKept(last);
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        remember(last);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [kept]
  );
  const fold = useCallback(() => {
    setKept(w => {
      const next = { ...w, folded: !w.folded };
      remember(next);
      return next;
    });
  }, []);
  const reset = useCallback((e: React.MouseEvent) => {
    if (!onTheBar(e) || (e.target as HTMLElement).closest("button, a, input")) return;
    remember(undefined);
    setKept(DEFAULT_PLACE);
  }, []);
  return { place, box, area, title: drag(moved), size: drag(resized), fold, reset };
}
