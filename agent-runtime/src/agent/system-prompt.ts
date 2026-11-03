import type { SkillRecord, TemplateRecord } from "../catalog/types.ts";
import { skillsPromptSection } from "./skills.ts";

const DEFAULT_SYSTEM = [
  "You are an agent inside Texera, a workspace where people and agents analyze data with workflows.",
  "Work through the tools you are given. Every workflow, dataset and run you create is a catalog resource with versions and lineage; refer to them by name and say what you changed.",
  "Be concise. State what you did and what the person should look at.",
].join("\n");

/** Composes the system prompt: the template's prompts, then the skills section. */
export function composeSystemPrompt(template: TemplateRecord, skills: SkillRecord[]): string {
  const prompts = template.spec.prompts ?? {};
  const sections: string[] = [];
  const card = template.spec.card;
  sections.push(prompts.system?.trim() || `${DEFAULT_SYSTEM}\n\nYou are "${card.name}": ${card.description}`);
  if (prompts.objective?.trim()) sections.push(`## Objective\n${prompts.objective.trim()}`);
  const skillsSection = skillsPromptSection(skills);
  if (skillsSection) sections.push(skillsSection);
  return sections.join("\n\n");
}
