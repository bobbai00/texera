import { queryOptions } from "@tanstack/react-query";
import { workflowsValidate } from "@texera/catalog-client";
import { workflowsListExecutionsOptions, workflowsReadOptions, workflowsReadVersionOptions } from "@texera/catalog-client/query";
import { type Compilation, interpret, logicalPlan, normalizeSpec, type WorkflowSpec } from "@texera/workflow-model";
import { unwrap } from "../api";

export const workflowQuery = (rid: string) => workflowsReadOptions({ path: { rid } });

/** The spec of one version, normalized. */
export const versionSpecQuery = (rid: string, vno: number) => ({
  ...workflowsReadVersionOptions({ path: { rid, vno } }),
  select: (v: { content: unknown }) => normalizeSpec(v.content),
  staleTime: Number.POSITIVE_INFINITY,
});

export const executionsQuery = (rid: string) => workflowsListExecutionsOptions({ path: { rid }, query: { limit: 50 } });

/** Compiles a draft spec on a unit: output schemas per port and errors per operator. */
export const compilationQuery = (rid: string, spec: WorkflowSpec | undefined, unit?: string) => {
  const plan = spec?.operators.length ? logicalPlan(spec) : undefined;
  const key = spec ? JSON.stringify({ operators: spec.operators, links: spec.links }) : undefined;
  return queryOptions({
    queryKey: ["compile", rid, unit ?? "", key ?? ""],
    enabled: !!plan,
    queryFn: async (): Promise<Compilation> => {
      const result = await unwrap(workflowsValidate({ path: { rid }, body: { spec, ...(unit ? { computingUnit: unit } : {}) } }));
      return interpret(plan as NonNullable<typeof plan>, result);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
};
