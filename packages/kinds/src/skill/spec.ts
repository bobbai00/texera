import { resourcesCreateVersion, skillsCreate } from "@texera/catalog-client";
import { skillsReadOptions } from "@texera/catalog-client/query";
import { Sparkles } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const skillQuery = (rid: string) => skillsReadOptions({ path: { rid } });

const starter = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description || "What this skill is for"}\n---\n\n# ${name}\n\nInstructions the agent follows when this skill applies.\n`;

export const skillKind: KindSpec = {
  kind: "skill",
  label: "Skill",
  plural: "Skills",
  slug: "s",
  librarySlug: "skills",
  icon: Sparkles,
  accent: "bg-kind-skill/12 text-kind-skill",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(skillQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const s = await unwrap(skillsCreate({ body: { name, description, project, spec: { name, description: description ?? "" } } }));
    await unwrap(resourcesCreateVersion({ path: { rid: s.metadata.rid }, body: { content: starter(name, description ?? ""), message: "Starter SKILL.md" } }));
    return { kind: "skill", rid: s.metadata.rid };
  },
};
