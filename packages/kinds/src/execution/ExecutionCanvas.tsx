// An execution as a canvas shows it: the workflow version it ran, which cannot be edited, each
// operator's card saying how it did, and under each card a cylinder for every result it kept. A
// result opens in a window over the canvas. The same on the execution's page and on the
// workflow's page while it shows an execution.

import { useQuery } from "@tanstack/react-query";
import type { Execution } from "@texera/catalog-client/types";
import { EmptyState, Skeleton } from "@texera/ui";
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useMemo } from "react";
import { operatorSchemasQuery } from "../queries";
import { resultLabel } from "../results/labels";
import { ResultsWindow } from "../results/ResultsWindow";
import { useScope } from "../scope";
import { parseUri } from "../uri";
import { createCanvasView } from "../workflow/canvas-view";
import { versionSpecQuery } from "../workflow/queries";
import { WorkflowCanvas } from "../workflow/WorkflowCanvas";
import { executionOverlay } from "./overlay";

export function ExecutionCanvas({
  execution,
  workflow,
  onOpen,
}: {
  execution: Execution;
  /** The workflow the execution is of. */
  workflow: string;
  /** Opens the execution's own page; absent on that page. */
  onOpen?: () => void;
}) {
  // A canvas of its own for each execution: what was open of one is nothing of another.
  const view = useMemo(() => createCanvasView(), []);
  const vno = parseUri(execution.spec.workflow)?.ref.vno;
  const { data: spec, error } = useQuery({ ...versionSpecQuery(workflow, vno ?? 0), enabled: vno !== undefined });
  const { data: schemas } = useQuery(operatorSchemasQuery(useScope()));
  const overlay = useMemo(() => executionOverlay(execution.status, execution.spec), [execution.status, execution.spec]);
  const labelOf = useCallback((operatorID: string) => resultLabel(spec, schemas, operatorID), [spec, schemas]);
  // Without the version (it cannot be read, or is gone) the results stand alone.
  if (error || vno === undefined)
    return (
      <ResultsWindow
        execution={execution}
        workflow={workflow}
        view={view}
        labelOf={labelOf}
        floating={false}
        {...(onOpen ? { onOpen } : {})}
      />
    );
  if (!spec) return <Skeleton className="m-4 h-64" />;
  if (spec.operators.length === 0) return <EmptyState>The workflow had no operators.</EmptyState>;
  return (
    <ReactFlowProvider>
      <div className="relative flex min-h-0 flex-1 flex-col" data-execution-stage={execution.metadata.rid}>
        <WorkflowCanvas provided spec={spec} overlay={overlay} view={view} className="h-full min-h-0 flex-1 bg-canvas">
          <ResultsWindow
            execution={execution}
            workflow={workflow}
            view={view}
            labelOf={labelOf}
            {...(onOpen ? { onOpen } : {})}
          />
        </WorkflowCanvas>
      </div>
    </ReactFlowProvider>
  );
}
