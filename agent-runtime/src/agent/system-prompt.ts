import type { SkillRecord, TemplateRecord } from "../catalog/types.ts";
import { type HandoffCandidate, handoffPromptSection } from "./handoff.ts";
import { skillsPromptSection } from "./skills.ts";

const DEFAULT_SYSTEM = [
  "You are an agent inside Texera, a workspace where people and agents analyze data with workflows.",
  "Work through the tools you are given. Every workflow, dataset and execution you create is a catalog resource with a texera:// URI, versions and lineage; refer to them by name and say what you changed.",
  "Be concise. State what you did and what the person should look at.",
].join("\n");

/** Composes the system prompt: the template's prompt, the skills, the handoffs. */
export function composeSystemPrompt(
  template: TemplateRecord,
  skills: SkillRecord[],
  handoffs: HandoffCandidate[],
): string {
  const sections: string[] = [];
  const card = template.spec.card;
  sections.push(template.spec.prompt?.trim() || `${DEFAULT_SYSTEM}\n\nYou are "${card.name}": ${card.description}`);
  const skillsSection = skillsPromptSection(skills);
  if (skillsSection) sections.push(skillsSection);
  const handoffSection = handoffPromptSection(handoffs);
  if (handoffSection) sections.push(handoffSection);
  return sections.join("\n\n");
}
