import type { WorkflowSpec, WorkflowStatus } from "@texera/catalog-client/types";
import { EMPTY_SPEC } from "@texera/workflow-model";
import { Workflow } from "lucide-react";
import { lazy } from "react";
import type { KindSpec } from "../types";
import { workflowQuery } from "./queries";

export const workflowKind: KindSpec = {
  kind: "workflow",
  label: "Workflow",
  plural: "Workflows",
  icon: Workflow,
  accent: "bg-kind-workflow/12 text-kind-workflow",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(workflowQuery(ref.rid)),
  defaultSpec: () => EMPTY_SPEC,
  facts: r => {
    const spec = r.spec as Partial<WorkflowSpec>;
    const n = spec.operators?.length ?? 0;
    const runs = (r.status as WorkflowStatus | undefined)?.executions;
    return [`v${r.metadata.head}`, `${n} operator${n === 1 ? "" : "s"}`, ...(runs ? [`${runs} run${runs === 1 ? "" : "s"}`] : [])];
  },
};
