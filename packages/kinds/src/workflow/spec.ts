import { workflowsCreateWithContent } from "@texera/catalog-client";
import { EMPTY_CONTENT } from "@texera/workflow-model";
import { Workflow } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";
import { contentQuery, workflowQuery } from "./queries";

export const workflowKind: KindSpec = {
  kind: "workflow",
  label: "Workflow",
  plural: "Workflows",
  slug: "w",
  librarySlug: "workflows",
  icon: Workflow,
  accent: "bg-kind-workflow/12 text-kind-workflow",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) =>
    Promise.all([qc.prefetchQuery(workflowQuery(ref.rid)), qc.prefetchQuery(contentQuery(ref.rid, ref.vno))]),
  create: async ({ name, description, project }) => {
    const { workflow } = await unwrap(
      workflowsCreateWithContent({ body: { name, description, project, content: EMPTY_CONTENT } })
    );
    return { kind: "workflow", rid: workflow.metadata.rid };
  },
  facts: r => [`v${r.metadata.headVersion}`],
};
