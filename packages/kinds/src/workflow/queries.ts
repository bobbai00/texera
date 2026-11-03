import { queryOptions } from "@tanstack/react-query";
import { workflowsContent, workflowsValidate } from "@texera/catalog-client";
import { workflowsListExecutionsOptions, workflowsReadOptions } from "@texera/catalog-client/query";
import { type Compilation, interpret, logicalPlan, normalizeContent, type WorkflowContent } from "@texera/workflow-model";
import { unwrap } from "../api";

export const workflowQuery = (rid: string) => workflowsReadOptions({ path: { rid } });

/** A version's content, normalized; the head when `vno` is absent. */
export const contentQuery = (rid: string, vno?: number) =>
  queryOptions({
    queryKey: ["workflow-content", rid, vno ?? "head"],
    queryFn: async () => {
      const version = await unwrap(workflowsContent({ path: { rid }, query: vno !== undefined ? { vno } : undefined }));
      return { vno: version.vno, content: normalizeContent(version.content), version };
    },
  });

export const runsQuery = (rid: string) => workflowsListExecutionsOptions({ path: { rid }, query: { limit: 50 } });

/** Compiles draft content on a unit: output schemas per port and errors per operator. */
export const compilationQuery = (rid: string, content: WorkflowContent | undefined, unit?: string) => {
  const plan = content?.operators.length ? logicalPlan(content) : undefined;
  const key = plan ? JSON.stringify({ operators: plan.operators, links: plan.links }) : undefined;
  return queryOptions({
    queryKey: ["compile", rid, unit ?? "", key ?? ""],
    enabled: !!plan,
    queryFn: async (): Promise<Compilation> => {
      const result = await unwrap(
        workflowsValidate({ path: { rid }, body: { content }, query: unit ? { computingUnit: unit } : undefined })
      );
      return interpret(plan as NonNullable<typeof plan>, result);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
};
