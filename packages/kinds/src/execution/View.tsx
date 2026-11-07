import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  resourcesUpdateMetadata,
  workflowsCancelExecution,
  workflowsDeleteExecution,
  workflowsPauseExecution,
  workflowsResumeExecution,
} from "@texera/catalog-client";
import type { Execution, ExecutionStatus } from "@texera/catalog-client/types";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorNote,
  formatDuration,
  SectionTitle,
  Skeleton,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  timeAgo,
} from "@texera/ui";
import type { WorkflowSpec } from "@texera/workflow-model";
import { ReactFlowProvider } from "@xyflow/react";
import {
  Bookmark,
  BookmarkCheck,
  Braces,
  GitBranch,
  Loader2,
  Pause,
  Play,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { unwrap } from "../api";
import { sizeLabel } from "../kinds/profiles";
import { isAbout, operatorSchemasQuery } from "../queries";
import { resultLabel } from "../results/labels";
import { type ResultLabel, ResultsWindow } from "../results/ResultsWindow";
import { ProjectScope, useScope } from "../scope";
import { UriChip } from "../shell/Chips";
import { JsonBlock } from "../shell/JsonBlock";
import { KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { useMay } from "../shell/may";
import { useOpenResource } from "../shell/navigation";
import { OpenError } from "../shell/OpenError";
import { RanOn } from "../shell/RanOn";
import type { KindViewProps } from "../types";
import { parseUri } from "../uri";
import { useWatch } from "../watch";
import { createCanvasView } from "../workflow/canvas-view";
import { useShow } from "../workflow/framing";
import { versionSpecQuery } from "../workflow/queries";
import { WorkflowCanvas } from "../workflow/WorkflowCanvas";
import { executionOverlay } from "./overlay";
import { executionQuery, isLive } from "./queries";

const TONE: Record<ExecutionStatus["phase"], "neutral" | "success" | "danger" | "warning"> = {
  pending: "neutral",
  provisioning: "warning",
  running: "warning",
  paused: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "danger",
};

/**
 * An execution: the workflow as it ran, each operator's card saying how it did, and under it
 * the results, each tied to the operator and the port it came out of.
 */
export default function ExecutionView({ ref, mode }: KindViewProps) {
  const queryClient = useQueryClient();
  const { data: x, error } = useQuery(executionQuery(ref.rid));
  // The execution's state as the unit reports it, as it arrives: phase, operators, ports.
  useWatch(ref.rid);
  const workflow = x?.metadata.parent ?? ref.parent ?? "";
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["resource", ref.rid] });
  const cancel = useMutation({
    mutationFn: () => unwrap(workflowsCancelExecution({ path: { rid: workflow, eid: ref.rid } })),
    onSuccess: refresh,
  });
  // Pause and resume go through the catalog to the unit; the phase follows the unit's report.
  const pause = useMutation({
    mutationFn: () => unwrap(workflowsPauseExecution({ path: { rid: workflow, eid: ref.rid } })),
    onSuccess: refresh,
  });
  const resume = useMutation({
    mutationFn: () => unwrap(workflowsResumeExecution({ path: { rid: workflow, eid: ref.rid } })),
    onSuccess: refresh,
  });
  const { expand } = useOpenResource();
  // What the person may do to it: keep it (write), delete it (delete); a viewer only looks.
  const may = useMay(ref.rid);
  // A finished execution can be deleted with its result tables; the workflow stays open, and
  // every list that showed the execution is asked again.
  const remove = useMutation({
    mutationFn: () => unwrap(workflowsDeleteExecution({ path: { rid: workflow, eid: ref.rid } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      void queryClient.invalidateQueries({ queryKey: [{ _id: "workflowsListExecutions", path: { rid: workflow } }] });
      queryClient.removeQueries({ predicate: query => isAbout(query.queryKey, ref.rid) });
      expand({ kind: "workflow", rid: workflow });
    },
  });
  // A kept execution's results stay under the retention policy: the label the hourly sweep honours.
  const keep = useMutation({
    mutationFn: (kept: boolean) => {
      const labels = { ...(x?.metadata.labels ?? {}) };
      if (kept) labels["texera.keep"] = "true";
      else delete labels["texera.keep"];
      return unwrap(resourcesUpdateMetadata({ path: { rid: ref.rid }, body: { labels } }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resource", ref.rid] }),
  });
  const [tab, setTab] = useState("results");
  if (error) return <OpenError error={error} kind="execution" />;
  if (!x) return <Skeleton className="m-4 h-64" />;
  const status = x.status ?? { phase: "pending" as const };
  const kept = x.metadata.labels?.["texera.keep"] === "true";
  const live = isLive(x as never);
  const inputs = x.spec.inputs ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col" data-execution-view={ref.rid}>
      <KindHeader
        ref={{ kind: "execution", rid: ref.rid, parent: workflow }}
        mode={mode}
        name={x.metadata.name}
        meta={
          <span className="flex items-center gap-1.5">
            <span>
              {timeAgo(x.metadata.createdAt)} · {formatDuration(status.startedAt, status.finishedAt) || "not started"}
            </span>
            <UriChip uri={x.spec.workflow} />
            <UriChip uri={x.spec.computingUnit} />
            <UriChip uri={x.spec.warehouse} />
          </span>
        }
        actions={
          <>
            <Badge tone={TONE[status.phase]} className="capitalize" data-phase={status.phase}>
              {live && <Loader2 className="size-3 animate-spin" />}
              {status.phase}
            </Badge>
            {status.phase === "running" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => pause.mutate()}
                disabled={pause.isPending}
                data-pause-execution
                title="Pause the execution; it keeps its state">
                <Pause className="fill-current" /> Pause
              </Button>
            )}
            {status.phase === "paused" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => resume.mutate()}
                disabled={resume.isPending}
                data-resume-execution
                title="Continue the execution">
                <Play className="fill-current" /> Resume
              </Button>
            )}
            {live && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
                data-stop-execution>
                <Square className="fill-current" /> Stop
              </Button>
            )}
            {!live && may.write === true && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => keep.mutate(!kept)}
                disabled={keep.isPending}
                data-keep-execution={kept ? "kept" : "free"}
                title={
                  kept
                    ? "Let the retention policy expire these results"
                    : "Keep these results past the retention policy"
                }>
                {kept ? <BookmarkCheck /> : <Bookmark />} {kept ? "Kept" : "Keep"}
              </Button>
            )}
            {!live && may.delete === true && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                data-delete-execution
                title="Delete this execution and its result tables">
                <Trash2 /> Delete
              </Button>
            )}
          </>
        }
      />
      {status.error !== undefined && status.error !== null && (
        <ErrorNote error={status.error} prefix="The execution failed" className="m-3" />
      )}
      {cancel.error && <ErrorNote error={cancel.error} prefix="Could not stop the execution" className="m-3" />}
      {pause.error && <ErrorNote error={pause.error} prefix="Could not pause the execution" className="m-3" />}
      {resume.error && <ErrorNote error={resume.error} prefix="Could not resume the execution" className="m-3" />}
      {remove.error && <ErrorNote error={remove.error} prefix="Could not delete the execution" className="m-3" />}
      {keep.error && (
        <ErrorNote error={keep.error} prefix="Could not change the execution's keep mark" className="m-3" />
      )}
      {status.resultsExpiredAt && (
        <p
          className="mx-3 mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
          data-results-expired>
          The result tables expired {timeAgo(status.resultsExpiredAt)} under the retention policy; what each operator
          did stays.
        </p>
      )}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="results">
            <Workflow /> Results
          </Tab>
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
          <Tab value="details">
            <Braces /> Details
          </Tab>
        </TabsList>
        <TabPanel value="results" className="flex min-h-0 flex-1 flex-col" keepMounted>
          {/* What the canvas lists (operator names, their settings' titles) is what the workflow's project can use. */}
          <ProjectScope project={x.metadata.project}>
            <Ran execution={x} workflow={workflow} />
          </ProjectScope>
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ kind: "execution", rid: ref.rid, parent: workflow }} />
        </TabPanel>
        <TabPanel value="details" className="scrollbar-thin space-y-4 overflow-y-auto p-4">
          <section className="space-y-2">
            <SectionTitle>Read</SectionTitle>
            {inputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">This execution read no dataset files.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {inputs.map(uri => (
                  <UriChip key={uri} uri={uri} emphasis />
                ))}
              </div>
            )}
          </section>
          <section className="space-y-2" data-execution-computing>
            <SectionTitle>Ran</SectionTitle>
            <p className="text-sm">
              <RanOn unit={x.spec.computingUnit} profile={x.spec.computing?.profile} warehouse={x.spec.warehouse} />
            </p>
            {x.spec.computing && (
              <p className="text-sm text-muted-foreground">
                {[sizeLabel(x.spec.computing), x.spec.computing.runtime ? `runtime ${x.spec.computing.runtime}` : ""].filter(Boolean).join(" · ") ||
                  "The unit reserved nothing of its own."}
              </p>
            )}
            {!!x.spec.computing?.packages?.length && (
              <div className="flex flex-wrap gap-1.5" data-execution-packages>
                {x.spec.computing.packages.map(p => (
                  <Chip key={p}>{p}</Chip>
                ))}
              </div>
            )}
          </section>
          <section className="space-y-2">
            <SectionTitle>As the catalog has it</SectionTitle>
            <JsonBlock value={x} />
          </section>
        </TabPanel>
      </Tabs>
    </div>
  );
}

/**
 * The workflow version the execution ran, laid out from its graph, with its results in a window
 * over it. A click on a card shows its result; the port the result on screen came out of is
 * lit, and a result pointed at points its card out.
 */
function Ran({ execution, workflow }: { execution: Execution; workflow: string }) {
  const view = useMemo(() => createCanvasView(), []);
  const vno = parseUri(execution.spec.workflow)?.ref.vno;
  const { data: spec, error } = useQuery({ ...versionSpecQuery(workflow, vno ?? 0), enabled: vno !== undefined });
  const { data: schemas } = useQuery(operatorSchemasQuery(useScope()));
  const overlay = useMemo(() => executionOverlay(execution.status, execution.spec), [execution.status, execution.spec]);
  const labelOf = useCallback((operatorID: string) => resultLabel(spec, schemas, operatorID), [spec, schemas]);
  // Without the version (it cannot be read, or is gone) the results stand alone.
  if (error || vno === undefined)
    return <ResultsWindow execution={execution} workflow={workflow} view={view} labelOf={labelOf} floating={false} />;
  if (!spec) return <Skeleton className="m-4 h-64" />;
  if (spec.operators.length === 0) return <EmptyState>The workflow had no operators.</EmptyState>;
  return (
    <ReactFlowProvider>
      <div className="relative flex min-h-0 flex-1 flex-col" data-execution-stage>
        <Stage execution={execution} workflow={workflow} spec={spec} overlay={overlay} view={view} labelOf={labelOf} />
      </div>
    </ReactFlowProvider>
  );
}

/** The canvas of the version that ran, its results floating over it; within the canvas's provider. */
function Stage({
  execution,
  workflow,
  spec,
  overlay,
  view,
  labelOf,
}: {
  execution: Execution;
  workflow: string;
  spec: WorkflowSpec;
  overlay: ReturnType<typeof executionOverlay>;
  view: ReturnType<typeof createCanvasView>;
  labelOf: (operatorID: string) => ResultLabel;
}) {
  const show = useShow(view);
  return (
    <WorkflowCanvas provided spec={spec} overlay={overlay} view={view} className="h-full min-h-0 flex-1 bg-canvas">
      <ResultsWindow execution={execution} workflow={workflow} view={view} labelOf={labelOf} onShowOperator={id => show(id)} />
    </WorkflowCanvas>
  );
}
