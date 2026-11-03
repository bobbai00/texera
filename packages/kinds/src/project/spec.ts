import { projectsCreate } from "@texera/catalog-client";
import { projectsReadOptions } from "@texera/catalog-client/query";
import { FolderKanban } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const projectQuery = (rid: string) => projectsReadOptions({ path: { rid } });

export const projectKind: KindSpec = {
  kind: "project",
  label: "Project",
  plural: "Projects",
  slug: "p",
  librarySlug: "projects",
  icon: FolderKanban,
  accent: "bg-kind-project/12 text-kind-project",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(projectQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const p = await unwrap(projectsCreate({ body: { name, description, project, spec: {} } }));
    return { kind: "project", rid: p.metadata.rid };
  },
};
