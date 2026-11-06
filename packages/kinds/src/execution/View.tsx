import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesUpdateMetadata, workflowsCancelExecution, workflowsDeleteExecution, workflowsPauseExecution, workflowsResumeExecution } from "@texera/catalog-client";
import type { Execution, ExecutionStatus, PortSummary } from "@texera/catalog-client/types";
import { Badge, Button, DataTable, EmptyState, ErrorNote, Skeleton, Tab, TabPanel, Tabs, TabsList, cn, formatDuration, formatNumber, timeAgo } from "@texera/ui";
import { AlertTriangle, Bookmark, BookmarkCheck, Braces, ChevronLeft, ChevronRight, Database, GitBranch, Loader2, Pause, Play, Square, Table2, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { unwrap } from "../api";
import { UriChip } from "../shell/Chips";
import { JsonBlock } from "../shell/JsonBlock";
import { KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { useOpenResource } from "../shell/navigation";
import type { KindViewProps } from "../types";
import { useWatch } from "../watch";
import { executionQuery, isLive, PAGE_SIZE, rowsQuery } from "./queries";
import { OpenError } from "../shell/OpenError";

const TONE: Record<ExecutionStatus["phase"], "neutral" | "success" | "danger" | "warning"> = {
  pending: "neutral",
  provisioning: "warning",
  running: "warning",
  paused: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "danger",
};

/** An execution: when and how it ended, each operator's state, its port results, and what it read. */
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
  // A finished execution can be deleted with its result tables; the workflow stays open.
  const remove = useMutation({
    mutationFn: () => unwrap(workflowsDeleteExecution({ path: { rid: workflow, eid: ref.rid } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
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
  const operators = Object.entries(status.operators ?? {});
  const errors = operators.filter(([, o]) => o.error);
  const ports = status.ports ?? [];
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
            {x.spec.environment && <UriChip uri={x.spec.environment} />}
          </span>
        }
        actions={
          <>
            <Badge tone={TONE[status.phase]} className="capitalize" data-phase={status.phase}>
              {live && <Loader2 className="size-3 animate-spin" />}
              {status.phase}
            </Badge>
            {status.phase === "running" && (
              <Button variant="secondary" size="sm" onClick={() => pause.mutate()} disabled={pause.isPending} data-pause-execution title="Pause the execution; it keeps its state">
                <Pause className="fill-current" /> Pause
              </Button>
            )}
            {status.phase === "paused" && (
              <Button variant="secondary" size="sm" onClick={() => resume.mutate()} disabled={resume.isPending} data-resume-execution title="Continue the execution">
                <Play className="fill-current" /> Resume
              </Button>
            )}
            {live && (
              <Button variant="secondary" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending} data-stop-execution>
                <Square className="fill-current" /> Stop
              </Button>
            )}
            {!live && (
              <Button variant="ghost" size="sm" onClick={() => keep.mutate(!kept)} disabled={keep.isPending} data-keep-execution={kept ? "kept" : "free"} title={kept ? "Let the retention policy expire these results" : "Keep these results past the retention policy"}>
                {kept ? <BookmarkCheck /> : <Bookmark />} {kept ? "Kept" : "Keep"}
              </Button>
            )}
            {!live && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending} data-delete-execution title="Delete this execution and its result tables">
                <Trash2 /> Delete
              </Button>
            )}
          </>
        }
      />
      {status.error !== undefined && status.error !== null && <ErrorNote error={status.error} prefix="The execution failed" className="m-3" />}
      {cancel.error && <ErrorNote error={cancel.error} prefix="Could not stop the execution" className="m-3" />}
      {pause.error && <ErrorNote error={pause.error} prefix="Could not pause the execution" className="m-3" />}
      {resume.error && <ErrorNote error={resume.error} prefix="Could not resume the execution" className="m-3" />}
      {remove.error && <ErrorNote error={remove.error} prefix="Could not delete the execution" className="m-3" />}
      {keep.error && <ErrorNote error={keep.error} prefix="Could not change the execution's keep mark" className="m-3" />}
      {status.resultsExpiredAt && (
        <p className="mx-3 mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-results-expired>
          The result tables expired {timeAgo(status.resultsExpiredAt)} under the retention policy; the summaries below stay.
        </p>
      )}
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="results">
            <Table2 /> Results ({ports.length})
          </Tab>
          <Tab value="operators">
            <Workflow /> Operators
          </Tab>
          <Tab value="inputs">
            <Database /> Inputs ({inputs.length})
          </Tab>
          {errors.length > 0 && (
            <Tab value="errors" className="text-destructive">
              <AlertTriangle /> Errors ({errors.length})
            </Tab>
          )}
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
          <Tab value="raw">
            <Braces /> JSON
          </Tab>
        </TabsList>
        <TabPanel value="results" className="flex min-h-0 flex-1 flex-col">
          <Results execution={x} workflow={workflow} ports={ports} expired={Boolean(status.resultsExpiredAt)} />
        </TabPanel>
        <TabPanel value="operators" className="scrollbar-thin overflow-y-auto">
          {operators.length === 0 ? (
            <EmptyState>No operator states reported yet.</EmptyState>
          ) : (
            <DataTable
              columns={[{ name: "operator" }, { name: "state" }, { name: "tuples", type: "long" }, { name: "node" }]}
              rows={operators.map(([opid, o]) => [opid, o.state, o.tuples !== undefined ? formatNumber(o.tuples) : "", o.computingNode ?? ""])}
              className="min-h-0"
            />
          )}
        </TabPanel>
        <TabPanel value="inputs" className="scrollbar-thin space-y-2 overflow-y-auto p-3">
          {inputs.length === 0 ? <EmptyState>This execution read no dataset files.</EmptyState> : inputs.map(uri => <UriChip key={uri} uri={uri} emphasis />)}
        </TabPanel>
        <TabPanel value="errors" className="scrollbar-thin space-y-2 overflow-y-auto p-3">
          {errors.map(([opid, o]) => (
            <ErrorNote key={opid} error={o.error} prefix={opid} />
          ))}
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ kind: "execution", rid: ref.rid, parent: workflow }} />
        </TabPanel>
        <TabPanel value="raw" className="scrollbar-thin overflow-y-auto p-3">
          <JsonBlock value={x} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Results({ execution, workflow, ports, expired }: { execution: Execution; workflow: string; ports: PortSummary[]; expired: boolean }) {
  const [picked, setPicked] = useState<string>();
  const key = (p: PortSummary) => `${p.operatorID}:${p.portID}`;
  const active = ports.find(p => key(p) === picked) ?? ports[0];
  if (!active) return <EmptyState>No port results yet.</EmptyState>;
  if (expired) {
    return (
      <DataTable
        columns={[{ name: "operator" }, { name: "port" }, { name: "rows", type: "long" }]}
        rows={ports.map(p => [p.operatorID, p.portID, p.rows !== undefined ? formatNumber(p.rows) : ""])}
        className="min-h-0"
      />
    );
  }
  return (
    <>
      <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b px-2 py-1.5" role="tablist">
        {ports.map(p => (
          <button
            key={key(p)}
            type="button"
            role="tab"
            aria-selected={key(p) === key(active)}
            onClick={() => setPicked(key(p))}
            data-port={key(p)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
              key(p) === key(active) ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            )}>
            <Table2 className="size-3.5" />
            {p.operatorID}
            <span className="opacity-60">{p.portID}</span>
            {p.rows !== undefined && <span className="opacity-60">· {formatNumber(p.rows)}</span>}
          </button>
        ))}
      </div>
      <PortRows key={key(active)} eid={execution.metadata.rid} workflow={workflow} port={active} />
    </>
  );
}

function PortRows({ eid, workflow, port }: { eid: string; workflow: string; port: PortSummary }) {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useQuery({ ...rowsQuery(workflow, eid, port.operatorID, port.portID, page), placeholderData: keepPreviousData });
  if (error) return <ErrorNote error={error} prefix="Could not load the result" className="m-3" />;
  if (isPending) return <Skeleton className="m-3 h-32" />;
  const total = data.total ?? port.rows ?? data.rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-port-rows>
      <DataTable columns={data.schema.map(a => ({ name: a.attributeName, type: a.attributeType }))} rows={data.rows} className="min-h-0 flex-1" />
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
        <span className="flex-1">
          {formatNumber(total)} row{total === 1 ? "" : "s"}
          {port.table && <span className="ml-2 font-mono text-2xs">{port.table}</span>}
        </span>
        <Button variant="ghost" size="icon-xs" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="ghost" size="icon-xs" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
