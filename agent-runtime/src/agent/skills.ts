/**
 * Skills with progressive disclosure: the system prompt lists each skill's name and
 * description; the `load_skill` tool returns the full body on demand.
 */
import { tool } from "ai";
import { z } from "zod";
import type { SkillRecord } from "../catalog/types.ts";

export const LOAD_SKILL_TOOL = "load_skill";

/** The prompt section that advertises the skills. */
export function skillsPromptSection(skills: SkillRecord[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "## Skills",
    `You have these skills. Before a task a skill covers, call \`${LOAD_SKILL_TOOL}\` with its name and follow the instructions it returns.`,
    ...lines,
  ].join("\n");
}

/** The tool that loads a skill's full instructions. */
export function loadSkillTool(skills: SkillRecord[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return tool({
    description:
      "Load the full instructions of one of your skills by name. Call it before doing work the skill covers.",
    inputSchema: z.object({ name: z.string().describe("The skill name as listed in the Skills section") }),
    execute: async ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        return { error: `unknown skill ${JSON.stringify(name)}`, available: [...byName.keys()] };
      }
      return { name: skill.name, instructions: skill.body };
    },
  });
}
