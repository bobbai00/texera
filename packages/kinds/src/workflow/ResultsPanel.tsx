import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, DataTable, SandboxedFrame, Skeleton, cn, formatNumber } from "@texera/ui";
import type { OperatorPredicate } from "@texera/workflow-model";
import { AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Table2, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { OperatorOutput, RunSnapshot, WorkflowRunner } from "../engine/engine";

const PAGE_SIZE = 50;

/** The workflow view's bottom dock: each operator's output from the live run, its errors and console. */
export function ResultsPanel({
  runner,
  snapshot,
  operators,
  focus,
}: {
  runner: WorkflowRunner;
  snapshot: RunSnapshot;
  operators: OperatorPredicate[];
  focus?: string | null;
}) {
  const name = (id: string) => operators.find(o => o.operatorID === id)?.customDisplayName ?? id;
  const withOutput = operators.filter(o => snapshot.outputs[o.operatorID]).map(o => o.operatorID);
  const withConsole = Object.keys(snapshot.console).filter(id => snapshot.console[id]?.length);
  const tabs = [...(snapshot.errors.length ? ["errors"] : []), ...withOutput, ...(withConsole.length ? ["console"] : [])];
  const [picked, setPicked] = useState<string>();
  const active =
    (picked && tabs.includes(picked) ? picked : undefined) ?? (focus && tabs.includes(focus) ? focus : undefined) ?? tabs[0];

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Run results" data-results-panel>
      <div className="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5" role="tablist">
        {tabs.length === 0 && (
          <span className="px-1 text-xs text-muted-foreground">
            {snapshot.state === "Uninitialized" ? "Run the workflow to see its results here." : "Waiting for results…"}
          </span>
        )}
        {tabs.map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === active}
            onClick={() => setPicked(t)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
              t === active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
              t === "errors" && "text-destructive"
            )}>
            {t === "errors" ? (
              <AlertTriangle className="size-3.5" />
            ) : t === "console" ? (
              <TerminalSquare className="size-3.5" />
            ) : snapshot.outputs[t]?.kind === "visualization" ? (
              <BarChart3 className="size-3.5" />
            ) : (
              <Table2 className="size-3.5" />
            )}
            {t === "errors" ? "Errors" : t === "console" ? "Console" : name(t)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {active === "errors" && (
          <ul className="space-y-2 p-3">
            {snapshot.errors.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: errors have no ids
              <li key={i} className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs">
                <p className="font-medium text-destructive">
                  {e.operatorId ? `${name(e.operatorId)}: ` : ""}
                  {e.message}
                </p>
                {e.details && e.details !== e.message && (
                  <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-2xs whitespace-pre-wrap text-muted-foreground">{e.details}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
        {active === "console" && (
          <div className="space-y-3 p-3 font-mono text-2xs">
            {withConsole.map(id => (
              <div key={id}>
                <p className="pb-1 font-sans text-xs font-medium">{name(id)}</p>
                {snapshot.console[id]?.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: console lines have no ids
                  <p key={i} className={cn("whitespace-pre-wrap", l.kind === "ERROR" && "text-destructive")}>
                    {l.title ? `${l.title}: ` : ""}
                    {l.message}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
        {active && snapshot.outputs[active] && (
          <Output runner={runner} operatorId={active} output={snapshot.outputs[active]} label={name(active)} />
        )}
      </div>
    </section>
  );
}

function Output({
  runner,
  operatorId,
  output,
  label,
}: {
  runner: WorkflowRunner;
  operatorId: string;
  output: OperatorOutput;
  label: string;
}) {
  if (output.kind === "visualization") {
    return output.html ? (
      <SandboxedFrame html={output.html} title={`${label} visualization`} className="h-full min-h-64 rounded-none border-0" />
    ) : (
      <p className="p-3 text-xs text-muted-foreground">The chart is still being drawn…</p>
    );
  }
  return <TablePages runner={runner} operatorId={operatorId} total={output.total} revision={output.revision} />;
}

function TablePages({
  runner,
  operatorId,
  total,
  revision,
}: {
  runner: WorkflowRunner;
  operatorId: string;
  total: number;
  revision: number;
}) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);
  const { data, error } = useQuery({
    queryKey: ["run-page", runner.unitRid, runner.workflowRid, operatorId, revision, current],
    queryFn: () => runner.page(operatorId, current, PAGE_SIZE),
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (error) return <p className="p-3 text-xs text-destructive">Could not load results: {error.message}</p>;
  if (!data) return <Skeleton className="m-3 h-32" />;
  const columns = data.schema.map(a => ({ name: a.attributeName, type: a.attributeType }));
  const rows = data.rows.map(r => data.schema.map(a => r[a.attributeName]));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DataTable columns={columns} rows={rows} className="min-h-0 flex-1" />
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
        <span className="flex-1">
          {formatNumber(total)} row{total === 1 ? "" : "s"}
        </span>
        <Button variant="ghost" size="icon-xs" disabled={current <= 1} onClick={() => setPage(current - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular-nums">
          {current} / {pages}
        </span>
        <Button variant="ghost" size="icon-xs" disabled={current >= pages} onClick={() => setPage(current + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
