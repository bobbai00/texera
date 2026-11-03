import { PlayCircle } from "lucide-react";
import { lazy } from "react";
import type { KindSpec } from "../types";
import { executionQuery } from "./queries";

export const executionKind: KindSpec = {
  kind: "execution",
  label: "Run",
  plural: "Runs",
  slug: "x",
  librarySlug: "runs",
  icon: PlayCircle,
  accent: "bg-kind-execution/15 text-kind-execution",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(executionQuery(ref.rid)),
};
