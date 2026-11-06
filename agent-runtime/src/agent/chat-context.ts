/**
 * What an agent is told about the chat it is in, at the end of every step's prompt: the date,
 * the project the chat is in, the computing unit a compile or an execution uses when the call names
 * none, what the person's app says they are looking at, who is in a chat several people write
 * in, and the add-on tools that could not be mounted. These are facts of one chat and one turn,
 * so they travel with the turn state and the instructions stay the same, cacheable text for
 * every chat.
 */
import type { ChatSettings, Setting } from "../catalog/types.ts";
import type { UnavailableServer } from "./mcp-tools.ts";

/** One thing the person's app says about where they are: AG-UI's context of a run. */
export interface AppContext {
  description: string;
  value: string;
}

const MAX_APP_ITEMS = 8;
const MAX_APP_TEXT = 500;

/**
 * What a run's input says the app shows the person, as the lines the agent reads: text only,
 * each on one line and bounded, since it is written by a client.
 */
export function appContext(context: unknown): AppContext[] {
  if (!Array.isArray(context)) return [];
  const line = (text: unknown) =>
    typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAX_APP_TEXT) : "";
  return context
    .map(
      (item): AppContext => ({
        description: line((item as AppContext | null)?.description),
        value: line((item as AppContext | null)?.value),
      }),
    )
    .filter((item) => item.value !== "")
    .slice(0, MAX_APP_ITEMS);
}

/** A chat several people write in: who they are, and the one whose message the turn answers. */
export interface ChatPeople {
  names: string[];
  asking: string;
}

export interface ChatContextInput {
  today: Date;
  /** Where the chat is: the catalog puts what a turn makes there and scopes its lists to it. */
  project: ChatSettings["project"];
  /** The unit the chat's settings resolve to; the catalog applies it to the chat's compiles and executions. */
  computingUnit?: Pick<Setting, "uri" | "name">;
  /** What the person's app says they are looking at, sent with their message. */
  app?: unknown;
  /** Set when several people write in the chat; their messages then carry their names. */
  people?: ChatPeople;
  unavailable: UnavailableServer[];
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Renders the chat's facts for the model. */
export function chatContext({ today, project, computingUnit, app, people, unavailable }: ChatContextInput): string {
  const lines = ["## This chat", `Today is ${today.toISOString().slice(0, 10)}.`];
  lines.push(
    `Project: ${project.name} (${project.rid}). What you make goes into it, and a search covers it and the built-ins unless it names another scope.`,
  );
  lines.push(
    computingUnit
      ? `Computing unit: ${computingUnit.name} (${computingUnit.uri}). Compiles and runs in this chat use it unless a call names another.`
      : "No computing unit is set: a call that compiles or runs has to name one, from list_computing_units.",
  );
  for (const { description, value } of appContext(app)) lines.push(description ? `${description}: ${value}` : value);
  if (people) {
    lines.push(
      `People in this chat: ${list(people.names)}. Each message of theirs starts with its writer's name in brackets; do not start yours that way.`,
      `You are answering ${people.asking}: their latest message is the request, and the rest of the chat is context for it.`,
    );
  }
  if (unavailable.length > 0) {
    lines.push(
      `Not available in this turn: the ${list(unavailable.map((s) => s.name))} tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.`,
    );
  }
  return lines.join("\n");
}
