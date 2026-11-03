import { computingUnitsCreate } from "@texera/catalog-client";
import { computingUnitsReadOptions } from "@texera/catalog-client/query";
import type { ComputingUnitSpec, ComputingUnitStatus } from "@texera/catalog-client/types";
import { Cpu } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const unitQuery = (rid: string) => ({
  ...computingUnitsReadOptions({ path: { rid } }),
  refetchInterval: 5000,
});

export const computingUnitKind: KindSpec = {
  kind: "computing_unit",
  label: "Computing unit",
  plural: "Computing units",
  slug: "u",
  librarySlug: "units",
  icon: Cpu,
  accent: "bg-kind-computing_unit/12 text-kind-computing_unit",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(unitQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const spec: ComputingUnitSpec = { unitKind: "local" };
    const u = await unwrap(computingUnitsCreate({ body: { name, description, project, spec } }));
    return { kind: "computing_unit", rid: u.metadata.rid };
  },
  facts: r => {
    const spec = r.spec as Partial<ComputingUnitSpec>;
    const status = r.status as Partial<ComputingUnitStatus> | undefined;
    return [spec.unitKind ?? "", status?.phase ?? ""].filter(Boolean);
  },
};
