import { describe, expect, test } from "bun:test";
import { chatContext } from "../src/agent/chat-context.ts";

const today = new Date("2026-11-05T23:30:00Z");
const project = { rid: "22222222-2222-4222-8222-222222222222", name: "lab" };
const where =
  "Project: lab (22222222-2222-4222-8222-222222222222). What you make goes into it, and a search covers it and what it inherits from the projects up its chain, to Texera, unless it names another scope.";

describe("chatContext", () => {
  test("says the date, where the chat is, and what is missing; nothing about where executions go", () => {
    const text = chatContext({
      today,
      project,
      unavailable: [{ name: "biomcp", uri: "texera://mcp-servers/b", reason: "connect ECONNREFUSED" }],
    });
    expect(text.split("\n")).toEqual([
      "## This chat",
      "Today is 2026-11-05.",
      where,
      "Not available in this turn: the biomcp tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.",
    ]);
  });

  test("says what the person's app shows them, as the app worded it", () => {
    const text = chatContext({
      today,
      project,
      unavailable: [],
      app: [
        { description: "The person is looking at", value: 'workflow "petals" (texera://workflows/w@3)' },
        { description: "", value: "operator avg is selected" },
      ],
    });
    expect(text.split("\n").slice(3)).toEqual([
      'The person is looking at: workflow "petals" (texera://workflows/w@3)',
      "operator avg is selected",
    ]);
  });

  test("keeps what the app says to single, bounded lines, and drops what says nothing", () => {
    const text = chatContext({
      today,
      project,
      unavailable: [],
      app: [
        { description: "Looking at", value: `two\nlines ${"x".repeat(2000)}` },
        { description: "Nothing", value: "   " },
        ...Array.from({ length: 20 }, (_, i) => ({ description: "More", value: String(i) })),
      ],
    });
    const lines = text.split("\n").slice(3);
    expect(lines[0]?.startsWith("Looking at: two lines xxx")).toBe(true);
    expect(lines[0]?.length).toBeLessThanOrEqual("Looking at: ".length + 500);
    expect(lines).not.toContain("Nothing:");
    expect(lines.length).toBe(8);
  });

  test("names every server that is missing", () => {
    const text = chatContext({
      today,
      project,
      unavailable: [
        { name: "biomcp", uri: "a", reason: "x" },
        { name: "lab tools", uri: "b", reason: "y" },
      ],
    });
    expect(text).toContain("the biomcp and lab tools tools");
  });

  test("in a chat several people write in, says who they are and whom the agent is answering", () => {
    const text = chatContext({
      today,
      project,
      unavailable: [],
      people: { names: ["Alice Liddell", "Bob Builder"], asking: "Bob Builder" },
    });
    expect(text.split("\n").slice(3)).toEqual([
      "People in this chat: Alice Liddell and Bob Builder. Each message of theirs starts with its writer's name in brackets; do not start yours that way.",
      "You are answering Bob Builder: their latest message is the request, and the rest of the chat is context for it.",
    ]);
    // One person's chat says nothing of it.
    expect(chatContext({ today, project, unavailable: [] })).not.toContain("People in this chat");
  });
});
