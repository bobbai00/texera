// The results of an execution, in a window over the canvas of the workflow that ran. Each result
// is named as its operator's card names it (its icon, its name, what it does), points the card
// out when pointed at, and a click shows it and brings the card into view; a click on a card
// shows its result here too. The window says which execution it is, how far it has gone and,
// when the canvas has moved on, which version ran. It is moved by its title bar, sized by its
// top right corner, folded to its title bar and left where it was put. Where there is no canvas
// (an execution whose version cannot be read) the results stand on their own.

import { useQuery } from "@tanstack/react-query";
import type { Execution, PortSummary } from "@texera/catalog-client/types";
import { Badge, Button, cn, EmptyState, formatDuration, formatNumber, timeAgo, Tooltip } from "@texera/ui";
import { operatorImage } from "@texera/workflow-model";
import { ArrowUpRight, BarChart3, ChevronDown, ChevronUp, GripHorizontal, Loader2, Table2, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { defaultResult, isChart, keptResult } from "../execution/overlay";
import { isLive } from "../execution/queries";
import { versionOf } from "../uri";
import { type CanvasView, portKey } from "../workflow/canvas-view";
import { pageOf, PortResult } from "./PortResult";
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

/** How a result is named: as its operator's card names it. */
export interface ResultLabel {
  title: string;
  /** What the operator does, in a few words, as its card says it. */
  summary?: string;
  /** Its type, for its icon. */
  type?: string;
}

const LIVE = new Set(["pending", "provisioning", "running", "paused"]);

export function ResultsWindow({
  execution,
  workflow,
  view,
  labelOf,
  onShowOperator,
  onOpen,
  onClose,
  showing,
  floating = true,
}: {
  execution: Execution;
  /** The workflow the execution is of. */
  workflow: string;
  view: CanvasView;
  labelOf: (operatorID: string) => ResultLabel;
  /** Brings an operator's card into view; absent where there is no canvas. */
  onShowOperator?: (operatorID: string) => void;
  /** Opens the execution's own page; absent on that page. */
  onOpen?: () => void;
  /** Puts the window away; absent where the results are the page. */
  onClose?: () => void;
  /** The version the canvas shows, to say when the execution ran another. */
  showing?: number;
  /** A window over the canvas, or the results standing on their own. */
  floating?: boolean;
}) {
  const eid = execution.metadata.rid;
  const ports = execution.status?.resultsExpiredAt ? [] : (execution.status?.ports ?? []).filter(keptResult);
  const chosen = useStore(view, s => s.result);
  const fallback = defaultResult(ports);
  const active =
    ports.find(p => portKey(p.operatorID, p.portID) === chosen) ??
    ports.find(p => portKey(p.operatorID, p.portID) === fallback);
  // The canvas points at the result on screen, also when nobody chose it.
  useEffect(() => {
    const key = active ? portKey(active.operatorID, active.portID) : null;
    if (view.getState().result !== key) view.getState().show(key);
  }, [active, view]);
  // A card pointed out by a result is pointed out no longer once the window is gone.
  useEffect(() => () => view.getState().point(null), [view]);
  const live = isLive(execution);

  const { place, box, area, title, size, fold, reset } = useWindowPlace(floating);
  const folded = floating && place.folded;
  // The canvas keeps the cards it brings into view clear of what the window covers.
  useEffect(() => {
    if (!floating || !area) return;
    view.getState().cover({
      left: place.left,
      bottom: place.bottom,
      width: place.width,
      height: folded ? TITLE_HEIGHT : place.height,
    });
  }, [floating, area, place.left, place.bottom, place.width, place.height, folded, view]);
  useEffect(() => () => view.getState().cover(null), [view]);
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
      aria-label="Results"
      data-results={eid}
      data-results-window={floating ? (folded ? "folded" : "open") : "page"}>
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-2 py-1.5",
          floating && "cursor-grab select-none active:cursor-grabbing"
        )}
        style={floating ? { minHeight: TITLE_HEIGHT } : undefined}
        onPointerDown={floating ? title : undefined}
        onDoubleClick={floating ? reset : undefined}
        title={floating ? "Drag to move; double-click to put it back" : undefined}
        data-results-title>
        {floating && <GripHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <Table2 className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="shrink-0 text-sm font-medium">Results</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={execution.metadata.name}>
          {execution.metadata.name}
        </span>
        {showing !== undefined && ran !== undefined && ran !== showing && (
          <Tooltip content={`These results are of version ${ran}; the canvas shows version ${showing}.`}>
            <Badge tone="warning" className="shrink-0" data-ran-version={ran}>
              ran v{ran}
            </Badge>
          </Tooltip>
        )}
        <span className="flex-1" />
        <Standing execution={execution} />
        {onOpen && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onOpen}
            title="Open this execution beside the workflow"
            data-open-execution>
            <ArrowUpRight /> Execution
          </Button>
        )}
        {floating && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fold}
            aria-label={folded ? "Unfold the results" : "Fold the results"}
            data-fold-results>
            {folded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Hide the results">
            <X />
          </Button>
        )}
      </header>
      {!folded && (
        <>
          <div
            className="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
            role="tablist"
            aria-label="Results by operator">
            {ports.map(port => (
              <ResultTab
                key={portKey(port.operatorID, port.portID)}
                workflow={workflow}
                eid={eid}
                port={port}
                label={labelOf(port.operatorID)}
                active={port === active}
                live={live}
                onPoint={pointing => view.getState().point(pointing ? port.operatorID : null)}
                onPick={() => {
                  view.getState().show(portKey(port.operatorID, port.portID));
                  onShowOperator?.(port.operatorID);
                }}
              />
            ))}
            {ports.length === 0 && (
              <span className="px-1.5 py-1 text-xs text-muted-foreground">
                {execution.status?.resultsExpiredAt
                  ? "The results expired under the retention policy."
                  : live
                    ? "Results show here as operators finish."
                    : "No result is kept: turn on an operator's eye, or run up to it."}
              </span>
            )}
          </div>
          {active ? (
            <PortResult
              key={portKey(active.operatorID, active.portID)}
              workflow={workflow}
              eid={eid}
              port={active}
              live={live}
            />
          ) : (
            <EmptyState className="py-8">Results show here as operators finish.</EmptyState>
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
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, [role=tab]")) return;
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
    if ((e.target as HTMLElement).closest("button, a")) return;
    remember(undefined);
    setKept(DEFAULT_PLACE);
  }, []);
  return { place, box, area, title: drag(moved), size: drag(resized), fold, reset };
}

/** Where the execution stands: its phase, and how far it has gone or when it ran. */
function Standing({ execution }: { execution: Execution }) {
  const status = execution.status;
  const phase = status?.phase ?? "pending";
  const operators = Object.values(status?.operators ?? {});
  const done = operators.filter(o => o.state.toLowerCase() === "completed").length;
  const going = LIVE.has(phase);
  const progress = going
    ? [operators.length ? `${done} of ${operators.length} done` : "", formatDuration(status?.startedAt, undefined)]
    : [timeAgo(execution.metadata.createdAt)];
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" data-latest-execution={phase}>
      <Badge
        tone={phase === "completed" ? "success" : phase === "failed" || phase === "cancelled" ? "danger" : "warning"}
        className="capitalize">
        {going && phase !== "paused" && <Loader2 className="size-3 animate-spin" />}
        {phase}
      </Badge>
      <span className="hidden max-w-56 truncate tabular-nums md:inline" data-execution-progress>
        {progress.filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

function ResultTab({
  workflow,
  eid,
  port,
  label,
  active,
  live,
  onPoint,
  onPick,
}: {
  workflow: string;
  eid: string;
  port: PortSummary;
  label: ResultLabel;
  active: boolean;
  /** The execution still goes: only the result on screen is read, as it fills. */
  live: boolean;
  onPoint: (pointing: boolean) => void;
  onPick: () => void;
}) {
  const { data } = useQuery({ ...pageOf(workflow, eid, port, 1, live), enabled: !live || active });
  const chart = data ? isChart(data.schema) : false;
  const Kind = chart ? BarChart3 : Table2;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onPick}
      onPointerEnter={() => onPoint(true)}
      onPointerLeave={() => onPoint(false)}
      onFocus={() => onPoint(true)}
      onBlur={() => onPoint(false)}
      title={[label.title, label.summary].filter(Boolean).join(": ")}
      data-port={portKey(port.operatorID, port.portID)}
      data-result-tab={portKey(port.operatorID, port.portID)}
      data-result-kind={data ? (chart ? "chart" : "table") : ""}
      className={cn(
        "inline-flex max-w-72 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
      )}>
      {label.type ? (
        <img
          src={operatorImage(label.type)}
          alt=""
          className="size-4 shrink-0 rounded-sm bg-white object-contain"
          draggable={false}
        />
      ) : (
        <Kind className={cn("size-3.5 shrink-0", active && "text-primary")} />
      )}
      <span className="shrink-0 font-medium">{label.title}</span>
      {label.summary && <span className="min-w-0 truncate font-normal opacity-70">{label.summary}</span>}
      {!port.portID.endsWith("-0") && <span className="shrink-0 font-normal opacity-70">{port.portID}</span>}
      {!chart && port.rows !== undefined && (
        <span className="shrink-0 font-normal tabular-nums opacity-70">{formatNumber(port.rows)}</span>
      )}
    </button>
  );
}
