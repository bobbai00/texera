import type { SkillSpec } from "@texera/catalog-client/types";
import { Sparkles } from "lucide-react";
import type { KindSpec } from "../types";

const starter = (name: string) => `# ${name}\n\nInstructions the agent follows when this skill applies.\n`;

export const skillKind: KindSpec = {
  kind: "skill",
  label: "Skill",
  plural: "Skills",
  icon: Sparkles,
  accent: "bg-kind-skill/12 text-kind-skill",
  long: ["body", "description"],
  defaultSpec: ({ name, description }) => ({ name, description: description ?? "What this skill is for", body: starter(name) }) satisfies SkillSpec,
  facts: r => {
    const body = (r.spec as Partial<SkillSpec>).body ?? "";
    return [`${body.split("\n").length} lines`];
  },
};
