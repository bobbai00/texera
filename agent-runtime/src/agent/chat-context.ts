/**
 * What an agent is told about the chat it is in, at the end of every step's prompt: the date,
 * the project the chat is in, the computing unit a compile or an execution uses when the call names
 * none, and the add-on tools that could not be mounted. These are facts of one chat and one
 * turn, so they travel with the turn state and the instructions stay the same, cacheable text
 * for every chat.
 */
import type { ChatSettings, Setting } from "../catalog/types.ts";
import type { UnavailableServer } from "./mcp-tools.ts";

export interface ChatContextInput {
  today: Date;
  /** Where the chat is: the catalog puts what a turn makes there and scopes its lists to it. */
  project: ChatSettings["project"];
  /** The unit the chat's settings resolve to; the catalog applies it to the chat's compiles and executions. */
  computingUnit?: Pick<Setting, "uri" | "name">;
  unavailable: UnavailableServer[];
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Renders the chat's facts for the model. */
export function chatContext({ today, project, computingUnit, unavailable }: ChatContextInput): string {
  const lines = ["## This chat", `Today is ${today.toISOString().slice(0, 10)}.`];
  lines.push(
    `Project: ${project.name} (${project.rid}). What you make goes into it, and a search covers it and the built-ins unless it names another scope.`,
  );
  lines.push(
    computingUnit
      ? `Computing unit: ${computingUnit.name} (${computingUnit.uri}). Compiles and runs in this chat use it unless a call names another.`
      : "No computing unit is set: a call that compiles or runs has to name one, from list_computing_units.",
  );
  if (unavailable.length > 0) {
    lines.push(
      `Not available in this turn: the ${list(unavailable.map((s) => s.name))} tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.`,
    );
  }
  return lines.join("\n");
}
