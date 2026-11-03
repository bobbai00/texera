import { datasetsCreate } from "@texera/catalog-client";
import { Database } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";
import { datasetQuery } from "./queries";

export const datasetKind: KindSpec = {
  kind: "dataset",
  label: "Dataset",
  plural: "Datasets",
  slug: "d",
  librarySlug: "datasets",
  icon: Database,
  accent: "bg-kind-dataset/12 text-kind-dataset",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(datasetQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const d = await unwrap(datasetsCreate({ body: { name, description, project, spec: {} } }));
    return { kind: "dataset", rid: d.metadata.rid };
  },
  facts: r => [r.metadata.headVersion ? `v${r.metadata.headVersion}` : "no version yet"],
};
