/**
 * A chat's name. The app starts a chat as "New chat", and the first thing asked in it names it:
 * the chat's model says in a few words what it is about, while the agent answers. Only a chat
 * still called that is named, so a name someone gave a chat stands.
 */
import { generateText, type LanguageModel } from "ai";
import { appContext } from "./chat-context.ts";

/** What the app calls a chat until it has a name of its own. */
export const UNNAMED_CHAT = "New chat";

const LONGEST_NAME = 60;
const LONGEST_MESSAGE = 2000;
const WAIT_MS = 20_000;

const INSTRUCTIONS = [
  "You name a chat on a research data platform, from its first message. Reply with the name and nothing else.",
  "At most five words, in the language of the message, naming its subject: for example Diabetes screening models, or Readmission by HbA1c result.",
  "No quotation marks and no full stop.",
].join("\n");

/** A model's reply as a name: its first line, bare, and short enough for a list. */
export function nameFrom(reply: string): string | undefined {
  const line = (reply.trim().split("\n")[0] ?? "").replace(/^[\s#*"'`“”‘’]+|[\s*"'`“”‘’.。]+$/g, "");
  const name = line.length <= LONGEST_NAME ? line : line.slice(0, LONGEST_NAME).replace(/\s+\S*$/, "");
  return name && name !== UNNAMED_CHAT ? name : undefined;
}

/** A name for a chat, from what was asked in it and what the person's app says they are looking at. */
export async function nameFor(model: LanguageModel, asked: string, app: unknown): Promise<string | undefined> {
  const looking = appContext(app).map(({ description, value }) => (description ? `${description}: ${value}` : value));
  const { text } = await generateText({
    model,
    instructions: INSTRUCTIONS,
    prompt: [asked.slice(0, LONGEST_MESSAGE), ...looking].join("\n"),
    maxOutputTokens: 40,
    abortSignal: AbortSignal.timeout(WAIT_MS),
  });
  return nameFrom(text);
}
