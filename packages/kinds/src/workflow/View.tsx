import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsRun } from "@texera/catalog-client";
import type { Execution, ExecutionStatus } from "@texera/catalog-client/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Select,
  Skeleton,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  timeAgo,
} from "@texera/ui";
import {
  type Compilation,
  normalizeSpec,
  type OperatorOverlay,
  operatorLabel,
  type WorkflowSpec,
} from "@texera/workflow-model";
import { ReactFlowProvider } from "@xyflow/react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  GitBranch,
  History,
  Loader2,
  Play,
  Users,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useStore } from "zustand";
import { unwrap } from "../api";
import { executionOverlay } from "../execution/overlay";
import { useRoom } from "../live/room";
import { keysOf, operatorSchemasQuery, unitsQuery } from "../queries";
import { ResultConnector } from "../results/Connector";
import { ResultsPanel } from "../results/ResultsPanel";
import { ProjectScope, useScope } from "../scope";
import { Access } from "../shell/Access";
import { EditableName, KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { metaLine } from "../shell/MetaLine";
import { OpenError } from "../shell/OpenError";
import { useOpenResource } from "../shell/navigation";
import { Versions } from "../shell/Versions";
import { useTellViewing } from "../shell/viewing";
import type { KindViewProps } from "../types";
import { uriOf } from "../uri";
import { useWatch } from "../watch";
import { createCanvasView } from "./canvas-view";
import { fixedDocument, liveDocument, type WorkflowDocument } from "./document";
import { createEditorStore, type EditorStore } from "./editor";
import { EditorCanvas } from "./EditorCanvas";
import { compilationQuery, executionsQuery, versionSpecQuery, workflowQuery } from "./queries";

const UNIT_KEY = "texera-unit";
const LIVE = new Set<ExecutionStatus["phase"]>(["pending", "provisioning", "running"]);

/** The workflow workspace: the same view in the side panel next to a chat and as a full page. */
export default function WorkflowView({ ref, mode }: KindViewProps) {
  const queryClient = useQueryClient();
  const { data: workflow, error } = useQuery(workflowQuery(ref.rid));
  // A version saved by anyone, a rename: the page follows the workflow as the catalog has it.
  useWatch(ref.rid, { onResource: r => queryClient.setQueryData(workflowQuery(ref.rid).queryKey, r as never) });
  const [vno, setVno] = useState<number | undefined>(ref.vno);
  const pinned = workflow !== undefined && vno !== undefined && vno !== workflow.metadata.head;
  const version = useQuery({ ...versionSpecQuery(ref.rid, vno ?? 0), enabled: pinned });
  if (error || version.error) return <OpenError error={error ?? version.error} kind="workflow" />;
  if (!workflow || (pinned && !version.data)) return <Skeleton className="m-4 h-[calc(100%-2rem)]" />;
  return (
    // What the editor lists (operators, datasets, credentials, units) is what the workflow's own
    // project can use, wherever the person is working.
    <ProjectScope project={workflow.metadata.project}>
      <Editor
        key={`${ref.rid}:${pinned ? vno : "head"}`}
        rid={ref.rid}
        mode={mode}
        name={workflow.metadata.name}
        meta={metaLine("workflow", workflow.metadata)}
        headVno={workflow.metadata.head}
        shown={pinned ? (version.data as WorkflowSpec) : undefined}
        fallback={normalizeSpec(workflow.spec)}
        onPin={setVno}
      />
    </ProjectScope>
  );
}

/** How long the page waits for the workflow's session before it shows the workflow without one. */
const JOIN_WITHIN_MS = 8000;

/**
 * The document the editor shows. The head is edited in the workflow's live session, with
 * whoever else is there; an older version is only shown. A session that cannot be joined
 * leaves the head on screen as the catalog has it, to look at.
 */
function useWorkflowDocument(rid: string, shown: WorkflowSpec | undefined, fallback: WorkflowSpec): { document?: WorkflowDocument; readonly: boolean; unreachable: boolean } {
  const room = useRoom(shown ? undefined : rid);
  const [joined, setJoined] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!room) return;
    const on = () => setJoined(true);
    if (room.isSynced) on();
    room.on("synced", on);
    const giveUp = setTimeout(() => setUnreachable(true), JOIN_WITHIN_MS);
    return () => {
      room.off("synced", on);
      clearTimeout(giveUp);
      setJoined(false);
    };
  }, [room]);
  return useMemo(() => {
    if (shown) return { document: fixedDocument(shown), readonly: true, unreachable: false };
    if (room && joined) return { document: liveDocument(room), readonly: room.authorizedScope === "readonly", unreachable: false };
    if (unreachable) return { document: fixedDocument(fallback), readonly: true, unreachable: true };
    return { readonly: true, unreachable: false };
  }, [shown, room, joined, unreachable, fallback]);
}

function Editor({
  rid,
  mode,
  name,
  meta,
  headVno,
  shown,
  fallback,
  onPin,
}: {
  rid: string;
  mode: "panel" | "page";
  name: string;
  meta: string;
  headVno: number;
  /** An older version to show instead of the head. */
  shown?: WorkflowSpec;
  /** The head as the catalog has it, shown when the workflow's session cannot be joined. */
  fallback: WorkflowSpec;
  onPin: (vno: number | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const { document, readonly, unreachable } = useWorkflowDocument(rid, shown, fallback);
  // The store is made once per document; the head and the name reach it through follow below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const store = useMemo(() => (document ? createEditorStore({ rid, name, headVno, readonly }, document) : undefined), [document, readonly]);
  useEffect(() => () => store?.getState().close(), [store]);
  useEffect(() => {
    store?.getState().follow(headVno, name);
  }, [store, headVno, name]);
  useEffect(() => {
    // A new version: the lists that name it follow.
    for (const key of keysOf(rid)) if (key[0] !== "resource") queryClient.invalidateQueries({ queryKey: key });
  }, [headVno, queryClient, rid]);
  if (!store) return <Skeleton className="m-4 h-[calc(100%-2rem)]" />;
  return (
    <ReactFlowProvider>
      {unreachable && (
        <p className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground" data-session-unreachable>
          The workflow's live session cannot be reached, so it is shown as it was last saved and cannot be edited right now.
        </p>
      )}
      <EditorLayout store={store} mode={mode} meta={meta} headVno={headVno} pinned={shown !== undefined} onPin={onPin} defaultUnit={store.getState().spec.defaultComputingUnit} />
    </ReactFlowProvider>
  );
}

/** What the cards say: how each operator did in the execution on screen, and what the compiler says is wrong with it now. */
function overlayFor(spec: WorkflowSpec, compilation: Compilation | undefined, execution: ExecutionStatus | undefined) {
  const ran = executionOverlay(execution);
  const overlay: Record<string, OperatorOverlay> = {};
  for (const op of spec.operators) {
    const error = compilation?.errors[op.operatorID];
    overlay[op.operatorID] = { ...ran[op.operatorID], ...(error ? { error } : {}) };
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
  const spec = useStore(store, s => s.spec);
  const name = useStore(store, s => s.name);
  const selected = useStore(store, s => s.selected);
  const readonly = useStore(store, s => s.readonly);
  const refusal = useStore(store, s => s.refusal);
  const vno = useStore(store, s => s.headVno);
  const queryClient = useQueryClient();
  const scope = useScope();
  // An agent asked about this page is told which operator is in focus, and reads the workflow
  // as it is on screen: an edit still waiting is saved first.
  const settle = useCallback(async () => {
    await store.getState().flush();
  }, [store]);
  useTellViewing(mode === "page" && selected ? `the operator ${selected} is selected` : undefined, mode === "page" ? settle : undefined);
  const { data: schemas } = useQuery(operatorSchemasQuery(scope));
  const { data: units } = useQuery(unitsQuery(scope));
  // How the canvas is looked at: how much the cards say, the card open, the result on screen.
  const view = useMemo(() => createCanvasView(), []);
  const [unitPick, setUnitPick] = useState<string | undefined>(() => defaultUnit ?? rememberedUnit());
  const unit = units?.find(u => u.metadata.uri === unitPick) ?? units?.find(u => u.status?.phase === "ready") ?? units?.[0];
  const { data: compilation } = useQuery(compilationQuery(rid, spec, unit?.metadata.uri));
  const executions = useQuery({
    ...executionsQuery(rid),
    // While an execution goes, the cards follow it second by second.
    refetchInterval: q => (q.state.data?.items.some(x => LIVE.has(x.status?.phase ?? "pending")) ? 1000 : false),
  });
  const latest = executions.data?.items[0] as Execution | undefined;
  const [tab, setTab] = useState("canvas");
  const [resultsOpen, setResultsOpen] = useState(true);
  const overlay = useMemo(() => overlayFor(spec, compilation, latest?.status), [spec, compilation, latest?.status]);
  const { beside } = useOpenResource();
  const live = latest !== undefined && LIVE.has(latest.status?.phase ?? "pending");
  // The canvas and the results under it, which the line from a result to its port is drawn over.
  const stage = useRef<HTMLDivElement>(null);
  const nameOf = useCallback(
    (operatorID: string) => {
      const op = spec.operators.find(o => o.operatorID === operatorID);
      if (!op) return operatorID;
      return op.customDisplayName || (schemas?.get(op.operatorType)?.userFriendlyName ?? operatorLabel(op));
    },
    [spec, schemas]
  );

  const run = useMutation({
    mutationFn: async () => {
      if (!unit) throw new Error("No computing unit is available.");
      // What runs is the version the session has just saved: exactly what is on screen.
      const vno = (await store.getState().flush()) ?? store.getState().headVno;
      // The catalog names the execution: a name of its own, however often a version is run.
      return unwrap(workflowsRun({ path: { rid }, body: { vno, computingUnit: unit.metadata.uri } }));
    },
    onSuccess: () => {
      // The execution shows where it runs: on the cards of this canvas, its results under it.
      queryClient.invalidateQueries({ queryKey: [{ _id: "workflowsListExecutions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      view.getState().show(null);
      setResultsOpen(true);
      setTab("canvas");
    },
  });

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
        name={<EditableName value={name} onChange={n => store.getState().rename(n)} disabled={readonly} label="Workflow name" />}
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
                value={unit?.metadata.uri ?? null}
                onChange={pickUnit}
                options={units.map(u => ({ value: u.metadata.uri, label: u.metadata.name }))}
                className="w-40"
              />
            )}
            {units !== undefined && !unit && (
              <Badge tone="danger">
                <Cpu className="size-3" /> No computing unit
              </Badge>
            )}
            {live && latest && (
              <Badge tone="warning">
                <Loader2 className="size-3 animate-spin" /> {latest.status?.phase}
              </Badge>
            )}
            <Button size="sm" onClick={() => run.mutate()} disabled={!unit || run.isPending || spec.operators.length === 0 || pinned} data-run>
              {run.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
            </Button>
          </>
        }
      />
      {refusal !== undefined && (
        // Said in full, to everyone in the session: the edits stay on screen and are not a version.
        <p className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive" data-not-saved>
          Not saved: {refusal}. The edits stay here; they become a version once this is put right.
        </p>
      )}
      {run.error && <ErrorNote error={run.error} prefix="Could not start the execution" className="m-3" />}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="canvas">
            <Workflow /> Canvas
          </Tab>
          <Tab value="executions">
            <Play /> Executions{executions.data ? ` (${executions.data.items.length})` : ""}
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="access">
            <Users /> Access
          </Tab>
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
        </TabsList>
        <TabPanel value="canvas" className="flex min-h-0 flex-1" keepMounted>
          <div ref={stage} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {latest && resultsOpen ? (
              <Group orientation="vertical" className="min-h-0 flex-1">
                <Panel id="canvas" minSize="25%">
                  <EditorCanvas
                    store={store}
                    view={view}
                    overlay={overlay}
                    compilation={compilation}
                    className="flex h-full min-w-0"
                  />
                </Panel>
                <Separator className="h-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                <Panel id="results" defaultSize="38%" minSize="15%">
                  <ResultsPanel
                    execution={latest}
                    workflow={rid}
                    view={view}
                    nameOf={nameOf}
                    className="h-full"
                    trailing={
                      <LatestExecution
                        execution={latest}
                        onOpen={() => beside({ kind: "execution", rid: latest.metadata.rid, parent: rid })}
                        onHide={() => setResultsOpen(false)}
                      />
                    }
                  />
                </Panel>
              </Group>
            ) : (
              <>
                <EditorCanvas
                  store={store}
                  view={view}
                  overlay={overlay}
                  compilation={compilation}
                  className="flex min-h-0 min-w-0 flex-1"
                />
                {latest && (
                  <button
                    type="button"
                    onClick={() => setResultsOpen(true)}
                    className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60"
                    data-show-results>
                    <ChevronUp className="size-3.5" /> Results of {latest.metadata.name}
                  </button>
                )}
              </>
            )}
            {latest && resultsOpen && <ResultConnector container={stage} view={view} />}
          </div>
        </TabPanel>
        <TabPanel value="executions" className="scrollbar-thin overflow-y-auto">
          <Executions rid={rid} onOpen={eid => beside({ kind: "execution", rid: eid, parent: rid })} />
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={rid} head={headVno} selected={pinned ? vno : undefined} onSelect={onPin} />
        </TabPanel>
        <TabPanel value="access" className="scrollbar-thin overflow-y-auto">
          <AccessOf rid={rid} />
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ kind: "workflow", rid, vno }} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

/** Which execution the results under the canvas are of, and the way to its own page. */
function LatestExecution({
  execution,
  onOpen,
  onHide,
}: {
  execution: Execution;
  onOpen: () => void;
  onHide: () => void;
}) {
  const phase = execution.status?.phase ?? "pending";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" data-latest-execution={phase}>
      <Badge
        tone={phase === "completed" ? "success" : phase === "failed" || phase === "cancelled" ? "danger" : "warning"}
        className="capitalize">
        {LIVE.has(phase) && <Loader2 className="size-3 animate-spin" />}
        {phase}
      </Badge>
      <span className="hidden max-w-56 truncate lg:inline">{timeAgo(execution.metadata.createdAt)}</span>
      <Button
        variant="ghost"
        size="xs"
        onClick={onOpen}
        title="Open this execution beside the workflow"
        data-open-execution>
        <ArrowUpRight /> Execution
      </Button>
      <Button variant="ghost" size="icon-xs" onClick={onHide} aria-label="Hide the results">
        <ChevronDown />
      </Button>
    </span>
  );
}

function AccessOf({ rid }: { rid: string }) {
  const { data } = useQuery(workflowQuery(rid));
  return data ? <Access resource={data} /> : <Skeleton className="m-3 h-24" />;
}

function Executions({ rid, onOpen }: { rid: string; onOpen: (eid: string) => void }) {
  const { data, isPending, error } = useQuery(executionsQuery(rid));
  if (error) return <ErrorNote error={error} prefix="Could not load executions" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-24" />;
  if (!data.items.length) return <EmptyState>No executions yet.</EmptyState>;
  return (
    <ul className="divide-y" data-executions>
      {data.items.map(x => {
        const phase = x.status?.phase ?? "pending";
        return (
          <li key={x.metadata.rid}>
            <button type="button" onClick={() => onOpen(x.metadata.rid)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/60" data-execution-row={phase}>
              <Badge tone={phase === "completed" ? "success" : phase === "failed" || phase === "cancelled" ? "danger" : "warning"}>{phase}</Badge>
              <span className="min-w-0 flex-1 truncate">{x.metadata.name}</span>
              <span className="text-xs text-muted-foreground">{x.spec.workflow.split("@")[1] ? `v${x.spec.workflow.split("@")[1]}` : ""}</span>
              <span className="text-xs text-muted-foreground">{timeAgo(x.metadata.createdAt)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Where the workflow on screen stands: saved as a version, on its way there, or kept from it and why. */
function SaveIndicator({ store }: { store: EditorStore }) {
  const state = useStore(store, s => s.saveState);
  const refusal = useStore(store, s => s.refusal);
  const renameError = useStore(store, s => s.saveError);
  if (state === "refused" || renameError)
    return (
      <span className="inline-flex items-center gap-1 text-destructive" title={state === "refused" ? refusal : renameError} data-save-state="refused">
        <AlertTriangle className="size-3" /> Not saved
      </span>
    );
  if (state === "offline")
    return (
      <span className="inline-flex items-center gap-1 text-destructive" title="Edits are kept here and sent when the connection is back." data-save-state="offline">
        <AlertTriangle className="size-3" /> Offline
      </span>
    );
  if (state === "saved")
    return (
      <span className="inline-flex items-center gap-1" data-save-state="saved">
        <Check className="size-3" /> Saved
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1" data-save-state="pending">
      <Loader2 className="size-3 animate-spin" /> Saving
    </span>
  );
}

export { uriOf };
