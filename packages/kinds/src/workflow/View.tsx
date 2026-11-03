import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsRun } from "@texera/catalog-client";
import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react";
import { Badge, Button, EmptyState, ErrorNote, Select, Skeleton, Tab, TabPanel, Tabs, TabsList, Tooltip, cn, timeAgo } from "@texera/ui";
import {
  addOperator,
  type Compilation,
  freeSpot,
  newOperator,
  type OperatorOverlay,
  STATUS_OF,
  type WorkflowContent,
} from "@texera/workflow-model";
import { AlertTriangle, Blocks, Check, CircleDashed, Cpu, GitBranch, History, Loader2, Play, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useStore } from "zustand";
import { unwrap } from "../api";
import { ACTIVE_STATES, type RunSnapshot } from "../engine/engine";
import { useWorkflowRun } from "../engine/useWorkflowRun";
import { operatorSchemasQuery, unitsQuery } from "../queries";
import { KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { metaLine } from "../shell/MetaLine";
import { useOpenResource } from "../shell/navigation";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { acquireEditor, type EditorStore, releaseEditor } from "./editor";
import { EditorCanvas } from "./EditorCanvas";
import { OperatorPalette } from "./OperatorPalette";
import { PropertyPanel } from "./PropertyPanel";
import { compilationQuery, contentQuery, runsQuery, workflowQuery } from "./queries";
import { ResultsPanel } from "./ResultsPanel";

const UNIT_KEY = "texera-unit";

/** The workflow workspace: the same view in the side panel next to a chat and as a full page. */
export default function WorkflowView({ ref, mode }: KindViewProps) {
  const { data: workflow, error } = useQuery(workflowQuery(ref.rid));
  const [vno, setVno] = useState<number | undefined>(ref.vno);
  const { data: version, error: contentError } = useQuery(contentQuery(ref.rid, vno));
  if (error || contentError) return <ErrorNote error={error ?? contentError} prefix="Could not open this workflow" className="m-4" />;
  if (!workflow || !version) return <Skeleton className="m-4 h-[calc(100%-2rem)]" />;
  const pinned = vno !== undefined && vno !== workflow.metadata.headVersion;
  return (
    <Editor
      key={`${ref.rid}:${pinned ? vno : "head"}`}
      rid={ref.rid}
      mode={mode}
      name={workflow.metadata.name}
      meta={metaLine(workflow.metadata)}
      headVno={workflow.metadata.headVersion}
      content={version.content}
      contentVno={version.vno}
      pinned={pinned}
      onPin={setVno}
      defaultUnit={workflow.spec.defaultComputingUnit}
    />
  );
}

function Editor({
  rid,
  mode,
  name,
  meta,
  headVno,
  content,
  contentVno,
  pinned,
  onPin,
  defaultUnit,
}: {
  rid: string;
  mode: "panel" | "page";
  name: string;
  meta: string;
  headVno: number;
  content: WorkflowContent;
  contentVno: number;
  pinned: boolean;
  onPin: (vno: number | undefined) => void;
  defaultUnit?: string;
}) {
  const queryClient = useQueryClient();
  const [store, setStore] = useState<EditorStore>();
  useEffect(() => {
    const s = acquireEditor({ rid, name, headVno: contentVno, content, readonly: pinned });
    setStore(s);
    return () => releaseEditor(rid);
    // The store is created once per (rid, pinned version); later content arrives through adopt below.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [rid, pinned]);
  useEffect(() => {
    store?.getState().adopt(content, contentVno, name);
  }, [store, content, contentVno, name]);
  useEffect(() => {
    // A save made a version: lists and the head content follow without a refetch storm.
    return store?.subscribe((state, previous) => {
      if (state.headVno !== previous.headVno) {
        queryClient.invalidateQueries({ queryKey: ["workflow-content", rid] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "workflowsRead", path: { rid } }] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
      }
    });
  }, [store, queryClient, rid]);
  if (!store) return <Skeleton className="m-4 h-[calc(100%-2rem)]" />;
  return (
    <ReactFlowProvider>
      <EditorLayout store={store} mode={mode} meta={meta} headVno={headVno} pinned={pinned} onPin={onPin} defaultUnit={defaultUnit} />
    </ReactFlowProvider>
  );
}

function overlayFor(content: WorkflowContent, compilation: Compilation | undefined, run: RunSnapshot) {
  const overlay: Record<string, OperatorOverlay> = {};
  for (const op of content.operators) {
    const progress = run.operators[op.operatorID];
    const error = compilation?.errors[op.operatorID];
    overlay[op.operatorID] = {
      ...(progress ? { status: STATUS_OF[progress.state], rows: progress.outputRows } : {}),
      ...(error ? { error } : {}),
    };
  }
  return overlay;
}

function rememberedUnit(): string | undefined {
  try {
    return localStorage.getItem(UNIT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function EditorLayout({
  store,
  mode,
  meta,
  headVno,
  pinned,
  onPin,
  defaultUnit,
}: {
  store: EditorStore;
  mode: "panel" | "page";
  meta: string;
  headVno: number;
  pinned: boolean;
  onPin: (vno: number | undefined) => void;
  defaultUnit?: string;
}) {
  const rid = store.getState().rid;
  const content = useStore(store, s => s.content);
  const name = useStore(store, s => s.name);
  const selected = useStore(store, s => s.selected);
  const readonly = useStore(store, s => s.readonly);
  const vno = useStore(store, s => s.headVno);
  const queryClient = useQueryClient();
  const { data: schemas } = useQuery(operatorSchemasQuery());
  const { data: units } = useQuery(unitsQuery());
  const [unitPick, setUnitPick] = useState<string | undefined>(() => defaultUnit ?? rememberedUnit());
  const unit = units?.find(u => u.metadata.rid === unitPick)?.metadata.rid ?? units?.find(u => u.status?.phase === "ready")?.metadata.rid ?? units?.[0]?.metadata.rid;
  const { data: compilation } = useQuery(compilationQuery(rid, content, unit));
  const { runner, snapshot } = useWorkflowRun(rid, unit);
  const [paletteOpen, setPaletteOpen] = useState(mode === "page" && !readonly);
  const [tab, setTab] = useState("canvas");
  const overlay = useMemo(() => overlayFor(content, compilation, snapshot), [content, compilation, snapshot]);
  const running = ACTIVE_STATES.has(snapshot.state);
  const showResults = !!runner && (snapshot.state !== "Uninitialized" || Object.keys(snapshot.outputs).length > 0);
  const { beside } = useOpenResource();

  const run = useMutation({
    mutationFn: async () => {
      await store.getState().flush();
      if (!unit) throw new Error("No computing unit is available.");
      runner?.reset();
      return unwrap(workflowsRun({ path: { rid }, body: { vno: store.getState().headVno, computingUnit: unit, name: store.getState().name } }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "workflowsListExecutions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "executionsList" }] });
    },
  });

  const { setCenter, getViewport } = useReactFlow();
  const flowStore = useStoreApi();
  const addFromPalette = (type: string) => {
    const schema = schemas?.get(type);
    if (!schema) return;
    const op = newOperator(schema);
    const { content: current, selected: after } = store.getState();
    const anchor = after ? current.operatorPositions[after] : undefined;
    const { width, height } = flowStore.getState();
    const view = getViewport();
    const middle = { x: (width / 2 - view.x) / view.zoom - 28, y: (height / 2 - view.y) / view.zoom - 28 };
    const spot = freeSpot(current, anchor ? { x: anchor.x + 180, y: anchor.y } : middle);
    store.getState().edit(c => addOperator(c, op, spot));
    store.getState().select(op.operatorID);
    setTimeout(() => void setCenter(spot.x + 28, spot.y + 28, { zoom: getViewport().zoom, duration: 200 }), 60);
  };

  const pickUnit = (u: string) => {
    setUnitPick(u);
    try {
      localStorage.setItem(UNIT_KEY, u);
    } catch {
      /* remembered for this page only */
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-workflow-view={rid}>
      <KindHeader
        ref={{ kind: "workflow", rid }}
        mode={mode}
        name={
          <input
            aria-label="Workflow name"
            defaultValue={name}
            key={name}
            disabled={readonly}
            onBlur={e => store.getState().rename(e.target.value)}
            onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
            className="block w-full truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-accent/50"
          />
        }
        meta={
          <span className="flex items-center gap-1.5">
            {pinned ? (
              <Badge tone="warning">
                v{vno} pinned ·{" "}
                <button type="button" className="underline" onClick={() => onPin(undefined)}>
                  back to head
                </button>
              </Badge>
            ) : (
              <SaveIndicator store={store} />
            )}
            <span className="truncate">{meta}</span>
          </span>
        }
        actions={
          <>
            {units && units.length > 0 && (
              <Select
                aria-label="Computing unit"
                value={unit ?? null}
                onChange={pickUnit}
                options={units.map(u => ({ value: u.metadata.rid, label: u.metadata.name }))}
                className="w-40"
              />
            )}
            <RunState snapshot={snapshot} unitName={units?.find(u => u.metadata.rid === unit)?.metadata.name} noUnit={units !== undefined && !unit} />
            {running ? (
              <Button size="sm" variant="secondary" onClick={runner?.kill} disabled={!runner}>
                <Square className="fill-current" /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => run.mutate()} disabled={!unit || run.isPending || content.operators.length === 0} data-run>
                {run.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
              </Button>
            )}
          </>
        }
      />
      {run.error && <ErrorNote error={run.error} prefix="Could not start the run" className="m-3" />}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="canvas">
            <Workflow /> Canvas
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="runs">
            <Play /> Runs
          </Tab>
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
          {!readonly && tab === "canvas" && (
            <Button
              variant={paletteOpen ? "secondary" : "ghost"}
              size="icon-xs"
              className="ml-auto"
              onClick={() => setPaletteOpen(o => !o)}
              aria-label="Toggle operator palette">
              <Blocks />
            </Button>
          )}
        </TabsList>
        <TabPanel value="canvas" className="flex min-h-0 flex-1" keepMounted>
          {paletteOpen && (
            <aside className="w-56 shrink-0 border-r bg-sidebar">
              <OperatorPalette onAdd={addFromPalette} />
            </aside>
          )}
          <Group orientation="vertical" className="min-w-0 flex-1">
            <Panel id="canvas" minSize="25%">
              <div className="flex h-full min-h-0">
                <EditorCanvas store={store} overlay={overlay} className="relative min-w-0 flex-1 bg-canvas" />
                {selected && (
                  <aside className="w-80 shrink-0 border-l bg-background">
                    <PropertyPanel store={store} compilation={compilation} />
                  </aside>
                )}
              </div>
            </Panel>
            {showResults && runner && (
              <>
                <Separator className="h-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                <Panel id="results" defaultSize="38%" minSize="15%">
                  <ResultsPanel runner={runner} snapshot={snapshot} operators={content.operators} focus={selected} />
                </Panel>
              </>
            )}
          </Group>
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={rid} head={headVno} selected={pinned ? vno : undefined} onSelect={onPin} />
        </TabPanel>
        <TabPanel value="runs" className="scrollbar-thin overflow-y-auto">
          <Runs rid={rid} onOpen={eid => beside({ kind: "execution", rid: eid })} />
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ kind: "workflow", rid, vno }} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Runs({ rid, onOpen }: { rid: string; onOpen: (eid: string) => void }) {
  const { data, isPending, error } = useQuery(runsQuery(rid));
  if (error) return <ErrorNote error={error} prefix="Could not load runs" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-24" />;
  if (!data.items.length) return <EmptyState>No runs yet.</EmptyState>;
  return (
    <ul className="divide-y" data-runs>
      {data.items.map(x => (
        <li key={x.eid}>
          <button type="button" onClick={() => onOpen(x.eid)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/60">
            <Badge tone={x.status === "completed" ? "success" : x.status === "failed" ? "danger" : "neutral"}>{x.status}</Badge>
            <span className="min-w-0 flex-1 truncate">{x.name || `Run ${x.eid.slice(0, 8)}`}</span>
            <span className="text-xs text-muted-foreground">v{x.workflow.vno}</span>
            <span className="text-xs text-muted-foreground">{timeAgo(x.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SaveIndicator({ store }: { store: EditorStore }) {
  const state = useStore(store, s => s.saveState);
  const error = useStore(store, s => s.saveError);
  if (state === "failed" || state === "conflict")
    return (
      <span className="inline-flex items-center gap-1 text-destructive" title={error}>
        <AlertTriangle className="size-3" /> {state === "conflict" ? "Head moved" : "Not saved"}
      </span>
    );
  if (state === "saved")
    return (
      <span className="inline-flex items-center gap-1">
        <Check className="size-3" /> Saved
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <Loader2 className="size-3 animate-spin" /> Saving
    </span>
  );
}

function RunState({ snapshot, unitName, noUnit }: { snapshot: RunSnapshot; unitName?: string; noUnit: boolean }) {
  if (noUnit) {
    return (
      <Badge tone="danger">
        <Cpu className="size-3" /> No computing unit
      </Badge>
    );
  }
  const running = ACTIVE_STATES.has(snapshot.state);
  return (
    <Tooltip content={unitName ? `Runs on "${unitName}"` : "Connecting to a computing unit"}>
      <Badge
        className={cn(
          snapshot.state === "Completed" && "text-success",
          (snapshot.state === "Failed" || snapshot.state === "Killed") && "text-destructive"
        )}>
        {running ? <Loader2 className="size-3 animate-spin" /> : snapshot.connected ? <Cpu className="size-3" /> : <CircleDashed className="size-3" />}
        {snapshot.state === "Uninitialized" ? (snapshot.connected ? "Ready" : "Connecting") : snapshot.state}
      </Badge>
    </Tooltip>
  );
}
