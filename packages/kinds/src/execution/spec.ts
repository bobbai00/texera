import type { ExecutionSpec, ExecutionStatus } from "@texera/catalog-client/types";
import { formatDuration } from "@texera/ui";
import { keptResult } from "./overlay";
import { PlayCircle } from "lucide-react";
import { lazy } from "react";
import type { KindSpec } from "../types";
import { executionQuery } from "./queries";

export const executionKind: KindSpec = {
  kind: "execution",
  label: "Execution",
  plural: "Executions",
  icon: PlayCircle,
  accent: "bg-kind-execution/15 text-kind-execution",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(executionQuery(ref.rid)),
  facts: r => {
    const spec = r.spec as Partial<ExecutionSpec>;
    const status = r.status as ExecutionStatus | undefined;
    const vno = spec.workflow?.split("@")[1];
    const ports = (status?.ports ?? []).filter(keptResult).length;
    return [
      status?.phase ?? "",
      vno ? `workflow v${vno}` : "",
      spec.upTo ? `up to ${spec.upTo}` : "",
      spec.reused?.length ? `${spec.reused.length} read from earlier runs` : "",
      `${ports} result${ports === 1 ? "" : "s"}`,
      formatDuration(status?.startedAt, status?.finishedAt),
    ].filter(Boolean);
  },
};
