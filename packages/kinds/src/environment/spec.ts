import { environmentsCreate } from "@texera/catalog-client";
import { environmentsReadOptions } from "@texera/catalog-client/query";
import type { EnvironmentSpec } from "@texera/catalog-client/types";
import { Package } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const environmentQuery = (rid: string) => environmentsReadOptions({ path: { rid } });

export const environmentKind: KindSpec = {
  kind: "environment",
  label: "Environment",
  plural: "Environments",
  slug: "e",
  librarySlug: "environments",
  icon: Package,
  accent: "bg-kind-environment/12 text-kind-environment",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(environmentQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const spec: EnvironmentSpec = { python: { packages: [] } };
    const e = await unwrap(environmentsCreate({ body: { name, description, project, spec } }));
    return { kind: "environment", rid: e.metadata.rid };
  },
  facts: r => {
    const n = (r.spec as Partial<EnvironmentSpec>).python?.packages?.length ?? 0;
    return [`${n} package${n === 1 ? "" : "s"}`];
  },
};
