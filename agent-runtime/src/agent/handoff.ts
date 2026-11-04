/**
 * The handoff tool: an agent hands the conversation to another template. The loop stops at
 * the call; the turn switches the conversation's template, announces it, and the target
 * finishes the same turn on the same stream.
 */
import { tool } from "ai";
import { z } from "zod";
import type { TemplateRecord } from "../catalog/types.ts";

export const HANDOFF_TOOL = "handoff";

/** A handoff candidate as the tool describes it. */
export interface HandoffCandidate {
  /** The template URI (without version). */
  uri: string;
  name: string;
  description: string;
}

export function candidatesOf(templates: TemplateRecord[]): HandoffCandidate[] {
  return templates.map((t) => ({
    uri: `texera://agent-templates/${t.rid}`,
    name: t.name,
    description: t.spec.card.description,
  }));
}

/** The prompt section that lists the handoffs. */
export function handoffPromptSection(candidates: HandoffCandidate[]): string {
  if (candidates.length === 0) return "";
  return [
    "## Handoffs",
    `When the request is better served by one of these agents, call \`${HANDOFF_TOOL}\` with its template URI and stop; it continues the conversation.`,
    ...candidates.map((c) => `- ${c.name} (${c.uri}): ${c.description}`),
  ].join("\n");
}

export function handoffTool(candidates: HandoffCandidate[]) {
  const byUri = new Map(candidates.map((c) => [c.uri, c]));
  return tool({
    description:
      "Hand the conversation to another agent. Give the template URI of one of the agents listed under Handoffs and, briefly, why.",
    inputSchema: z.object({
      template: z.string().describe("The template URI of the agent, as listed under Handoffs"),
      reason: z.string().optional().describe("Why, in one sentence"),
    }),
    execute: async ({ template, reason }) => {
      const candidate = byUri.get(template);
      if (!candidate) {
        return { error: `unknown handoff target ${JSON.stringify(template)}`, available: [...byUri.keys()] };
      }
      return { ok: true, handoff: candidate.uri, name: candidate.name, reason: reason ?? "" };
    },
  });
}

/** The target of a successful handoff call, read from the tool result. */
export function handoffTarget(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { ok?: unknown; handoff?: unknown };
  return o.ok === true && typeof o.handoff === "string" ? o.handoff : undefined;
}
