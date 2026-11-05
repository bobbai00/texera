/**
 * What an agent is told about the chat it is in, at the end of every step's prompt: the date,
 * the computing unit the chat's runs use, and the add-on tools that could not be mounted. These
 * are facts of one chat and one turn, so they travel with the turn state and the instructions
 * stay the same, cacheable text for every chat.
 */
import type { UnavailableServer } from "./mcp-tools.ts";

/** The settings of a chat an agent should know. */
export interface ChatFacts {
  /** The computing unit the chat names; the catalog applies it to the chat's compiles and runs. */
  computingUnit?: { uri: string; name: string; phase?: string };
}

export interface ChatContextInput {
  today: Date;
  chat?: ChatFacts;
  unavailable: UnavailableServer[];
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Renders the chat's facts for the model. */
export function chatContext({ today, chat, unavailable }: ChatContextInput): string {
  const lines = ["## This chat", `Today is ${today.toISOString().slice(0, 10)}.`];
  const unit = chat?.computingUnit;
  if (unit) {
    lines.push(
      `Computing unit: ${unit.name} (${unit.uri})${unit.phase ? `, ${unit.phase}` : ""}. Compiles and runs in this chat use it unless a call names another.`,
    );
  }
  if (unavailable.length > 0) {
    lines.push(
      `Not available in this turn: the ${list(unavailable.map((s) => s.name))} tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.`,
    );
  }
  return lines.join("\n");
}
