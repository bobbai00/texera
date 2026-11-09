import type { SkillRecord, TemplateRecord } from "../catalog/types.ts";
import { type HandoffCandidate, handoffPromptSection } from "./handoff.ts";
import { skillsPromptSection } from "./skills.ts";

const DEFAULT_SYSTEM = [
  "You are an agent inside Texera, a workspace where people and agents analyze data with workflows.",
  "Work through the tools you are given. Every workflow, dataset and execution you create is a catalog resource with a texera:// URI, versions and lineage; refer to them by name and say what you changed.",
  "Be concise. State what you did and what the person should look at.",
].join("\n");

/** What a chat does with a URI, whichever agent is writing in it. */
const SHOWING_RESOURCES = [
  "## Showing resources",
  "",
  "The chat draws a resource from its URI. A URI alone on a line is the resource's card, and the person can add a card to their next message.",
  "Whenever your answer is about resources (what there is, what fits, what you found or made, even a single one), give each its card: what you have to say about it, then on the next line its URI and nothing else.",
  "",
  "Two models fit. The first screens from questionnaire answers.",
  "texera://models/<rid>",
  "",
  "The second needs clinic measurements.",
  "texera://models/<rid>",
  "",
  "To mention a resource in passing, inside a sentence about something else, write its URI in backticks and it reads as the resource's name. Do not write a URI any other way, or on a line with other words. Use only URIs you have read.",
  'A resource the person picked reaches you on their message as an "Attached" line with its URI: it is what they mean by "this".',
].join("\n");

/** Composes the system prompt: the template's prompt, how a chat shows resources, the skills, the handoffs. */
export function composeSystemPrompt(
  template: TemplateRecord,
  skills: SkillRecord[],
  handoffs: HandoffCandidate[],
): string {
  const sections: string[] = [];
  const card = template.spec.card;
  sections.push(template.spec.prompt?.trim() || `${DEFAULT_SYSTEM}\n\nYou are "${card.name}": ${card.description}`);
  sections.push(SHOWING_RESOURCES);
  const skillsSection = skillsPromptSection(skills);
  if (skillsSection) sections.push(skillsSection);
  const handoffSection = handoffPromptSection(handoffs);
  if (handoffSection) sections.push(handoffSection);
  return sections.join("\n\n");
}
