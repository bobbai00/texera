import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsRun } from "@texera/catalog-client";
import type { ComputingUnitSpec, Execution, ExecutionStatus, ProjectSpec } from "@texera/catalog-client/types";
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
  Check,
  Cpu,
  GitBranch,
  History,
  Loader2,
  Lock,
  Play,
  Table2,
  Users,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { unwrap } from "../api";
import { executionOverlay } from "../execution/overlay";
import { useRoom } from "../live/room";
import { masterOf } from "../kinds/profiles";
import { keysOf, operatorSchemasQuery, resourceQuery, searchQuery, settingsQuery, unitsQuery } from "../queries";
import { resultLabel } from "../results/labels";
import { ResultsWindow } from "../results/ResultsWindow";
import { ProjectScope, useScope } from "../scope";
import { Access } from "../shell/Access";
import { EditableName, KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { metaLine } from "../shell/MetaLine";
import { OpenError } from "../shell/OpenError";
import { useOpenResource } from "../shell/navigation";
import { Named } from "../shell/RanOn";
import { Versions } from "../shell/Versions";
import { useTellViewing } from "../shell/viewing";
import type { KindViewProps } from "../types";
import { uriOf } from "../uri";
import { useWatch } from "../watch";
import { createCanvasView, portKey } from "./canvas-view";
import { useShow } from "./framing";
import { fixedDocument, liveDocument, type WorkflowDocument } from "./document";
import { createEditorStore, type EditorStore } from "./editor";
import { EditorCanvas } from "./EditorCanvas";
import { compilationQuery, executionsQuery, versionSpecQuery, workflowQuery } from "./queries";
import { isRefusal, notRunnable, refusedOperator } from "./runnable";

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

/** How long the page waits for the workflow's session before it says it cannot be reached. */
const JOIN_WITHIN_MS = 8000;

/**
 * The document the editor shows. The head is edited in the workflow's live session, with
 * whoever else is there; an older version is only shown. Until the session is joined the head
 * is shown as the catalog has it, to look at, so the canvas is there at once; a session that
 * cannot be joined leaves it so, and says why.
 */
function useWorkflowDocument(
  rid: string,
  shown: WorkflowSpec | undefined,
  fallback: WorkflowSpec
): { document: WorkflowDocument; readonly: boolean; unreachable: boolean; connecting: boolean } {
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
  // The head the catalog has is what is shown while the session is joined: kept as it was
  // when the page opened, so a version saved meanwhile does not redraw it for nothing.
  const [first] = useState(fallback);
  return useMemo(() => {
    if (shown) return { document: fixedDocument(shown), readonly: true, unreachable: false, connecting: false };
    if (room && joined) return { document: liveDocument(room), readonly: room.authorizedScope === "readonly", unreachable: false, connecting: false };
    return { document: fixedDocument(first), readonly: true, unreachable, connecting: !unreachable };
  }, [shown, room, joined, unreachable, first]);
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
  const { document, readonly, unreachable, connecting } = useWorkflowDocument(rid, shown, fallback);
  // The store is made once per document; the head and the name reach it through follow below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const store = useMemo(() => createEditorStore({ rid, name, headVno, readonly }, document), [document, readonly]);
  useEffect(() => () => store?.getState().close(), [store]);
  useEffect(() => {
    store?.getState().follow(headVno, name);
  }, [store, headVno, name]);
  useEffect(() => {
    // A new version: the lists that name it follow.
    for (const key of keysOf(rid)) if (key[0] !== "resource") queryClient.invalidateQueries({ queryKey: key });
  }, [headVno, queryClient, rid]);
  return (
    <ReactFlowProvider>
      {unreachable && (
        <p className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground" data-session-unreachable>
          The workflow's live session cannot be reached, so it is shown as it was last saved and cannot be edited right now.
        </p>
      )}
      <EditorLayout store={store} mode={mode} meta={meta} headVno={headVno} pinned={shown !== undefined} onPin={onPin} connecting={connecting} />
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

function EditorLayout({
  store,
  mode,
  meta,
  headVno,
  pinned,
  onPin,
  connecting,
}: {
  store: EditorStore;
  mode: "panel" | "page";
  meta: string;
  headVno: number;
  pinned: boolean;
  onPin: (vno: number | undefined) => void;
  /** The workflow's live session is being joined: what is shown is the head, to look at. */
  connecting: boolean;
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
  // Where a run goes and keeps its results: what is picked here for this page's runs, else what
  // the workflow, its project or the platform names, as the catalog decides for anyone's run.
  const { data: warehouses } = useQuery(searchQuery({ kind: "warehouse", scope }));
  const { data: project } = useQuery({ ...resourceQuery(scope ?? ""), enabled: !!scope });
  const { data: settings } = useQuery(settingsQuery());
  const defaults = { project: project?.spec as ProjectSpec | undefined, platform: settings?.spec.defaults };
  const [unitPick, setUnitPick] = useState<string>();
  const named = unitPick ?? spec.defaultComputingUnit ?? defaults.project?.defaultComputingUnit ?? defaults.platform?.computingUnit;
  // A unit the person may not run on is not among theirs: a ready one of theirs stands in.
  const unit = units?.find(u => u.metadata.uri === named) ?? units?.find(u => u.status?.phase === "ready") ?? units?.[0];
  const madeFrom = unit && masterOf(unit.spec as ComputingUnitSpec)?.profile;
  const [warehousePick, setWarehousePick] = useState<string>();
  const warehouse = warehousePick ?? spec.defaultWarehouse ?? defaults.project?.defaultWarehouse ?? defaults.platform?.warehouse;
  const compiled = useQuery(compilationQuery(rid, spec, unit?.metadata.uri));
  const compilation = compiled.data;
  const executions = useQuery({
    ...executionsQuery(rid),
    // While an execution goes, the cards follow it second by second.
    refetchInterval: q => (q.state.data?.items.some(x => LIVE.has(x.status?.phase ?? "pending")) ? 1000 : false),
  });
  const latest = executions.data?.items[0] as Execution | undefined;
  const [tab, setTab] = useState("canvas");
  const [resultsOpen, setResultsOpen] = useState(true);
  const { beside } = useOpenResource();
  const live = latest !== undefined && LIVE.has(latest.status?.phase ?? "pending");
  const nameOf = useCallback(
    (operatorID: string) => {
      const op = spec.operators.find(o => o.operatorID === operatorID);
      if (!op) return operatorID;
      return op.customDisplayName || (schemas?.get(op.operatorType)?.userFriendlyName ?? operatorLabel(op));
    },
    [spec, schemas]
  );

  // A result is named as its operator's card names it; picking one brings the card into view.
  const labelOf = useCallback((operatorID: string) => resultLabel(spec, schemas, operatorID), [spec, schemas]);
  const show = useShow(view);
  const showCard = useCallback((operatorID: string) => show(operatorID), [show]);

  // Runs the workflow, or up to one operator: only what leads to it, and its result is kept.
  const run = useMutation({
    mutationFn: async (upTo: string | undefined) => {
      if (!unit) throw new Error("No computing unit is available.");
      // What runs is the version the session has just saved: exactly what is on screen.
      const vno = (await store.getState().flush()) ?? store.getState().headVno;
      // The catalog names the execution: a name of its own, however often a version is run.
      return unwrap(
        workflowsRun({
          path: { rid },
          body: { vno, computingUnit: unit.metadata.uri, ...(warehousePick ? { warehouse: warehousePick } : {}), ...(upTo ? { upTo } : {}) },
        })
      );
    },
    onSuccess: (_, upTo) => {
      // The execution shows where it runs: on the cards of this canvas, its results under it.
      queryClient.invalidateQueries({ queryKey: [{ _id: "workflowsListExecutions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      // A run up to an operator was asked for its result: that is the one on screen.
      const port = upTo && store.getState().spec.operators.find(o => o.operatorID === upTo)?.outputPorts?.[0]?.portID;
      view.getState().show(upTo && port ? portKey(upTo, port) : null);
      setResultsOpen(true);
      setTab("canvas");
    },
  });
  const runTo = useCallback((operatorID: string) => run.mutate(operatorID), [run.mutate]);
  // A person who may look at the workflow but lacks something it needs to run (a dataset not
  // shared with them, the unit) is told what, by the dry run before they press Run, or by Run.
  const blocked = isRefusal(compiled.error) ? compiled.error : isRefusal(run.error) ? run.error : undefined;
  const overlay = useMemo(() => {
    const said = overlayFor(spec, compilation, latest?.status);
    const operator = blocked && refusedOperator(blocked);
    if (operator && said[operator]) said[operator] = { ...said[operator], error: "Not shared with you: ask the workflow's owner" };
    return said;
  }, [spec, compilation, latest?.status, blocked]);

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
            ) : connecting ? (
              <span className="inline-flex items-center gap-1" title="Joining the workflow's live session" data-save-state="connecting">
                <Loader2 className="size-3 animate-spin" /> Connecting
              </span>
            ) : (
              <SaveIndicator store={store} />
            )}
            <span className="truncate">{meta}</span>
          </span>
        }
        actions={
          <>
            {units && units.length > 0 && (
              // Where the run goes, said as a sentence: on a unit (its profile) · results in a warehouse.
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" data-run-target>
                on
                <Select
                  aria-label="Computing unit"
                  value={unit?.metadata.uri ?? null}
                  onChange={setUnitPick}
                  options={units.map(u => ({ value: u.metadata.uri, label: u.metadata.name }))}
                  className="w-36"
                />
                {madeFrom && (
                  <span className="truncate" data-run-profile>
                    (<Named uri={madeFrom} />)
                  </span>
                )}
                {warehouses && warehouses.items.length > 0 && (
                  <>
                    <span className="shrink-0">· results in</span>
                    <Select
                      aria-label="Warehouse"
                      value={warehouse ?? null}
                      onChange={setWarehousePick}
                      options={warehouses.items.map(w => ({ value: w.metadata.uri, label: w.metadata.name }))}
                      className="w-36"
                    />
                  </>
                )}
              </span>
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
            <Button
              size="sm"
              onClick={() => run.mutate(undefined)}
              disabled={!unit || run.isPending || spec.operators.length === 0 || pinned}
              data-run>
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
      {blocked && (
        <p className="flex items-start gap-1.5 border-b bg-warning/10 px-3 py-1.5 text-xs" data-run-blocked>
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>You can look at this workflow but not run it. {notRunnable(blocked, nameOf)}</span>
        </p>
      )}
      {run.error && !isRefusal(run.error) && <ErrorNote error={run.error} prefix="Could not start the execution" className="m-3" />}
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
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <EditorCanvas
              store={store}
              view={view}
              overlay={overlay}
              compilation={compilation}
              onRunTo={pinned ? undefined : runTo}
              className="flex min-h-0 min-w-0 flex-1">
              {latest &&
                (resultsOpen ? (
                  <ResultsWindow
                    execution={latest}
                    workflow={rid}
                    view={view}
                    labelOf={labelOf}
                    onShowOperator={showCard}
                    onOpen={() => beside({ kind: "execution", rid: latest.metadata.rid, parent: rid })}
                    onClose={() => setResultsOpen(false)}
                    showing={vno}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setResultsOpen(true)}
                    className="nokey absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:bg-accent"
                    data-show-results>
                    <Table2 className="size-3.5 text-primary" /> Results of {latest.metadata.name}
                  </button>
                ))}
            </EditorCanvas>
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
