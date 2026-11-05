import { describe, expect, test } from "bun:test";
import { chatContext } from "../src/agent/chat-context.ts";

const today = new Date("2026-11-05T23:30:00Z");
const unit = { uri: "texera://computing-units/11111111-1111-4111-8111-111111111111", name: "alice's unit" };
const project = { rid: "22222222-2222-4222-8222-222222222222", name: "lab" };
const where =
  "Project: lab (22222222-2222-4222-8222-222222222222). What you make goes into it, and a search covers it and the built-ins unless it names another scope.";

describe("chatContext", () => {
  test("says the date, where this chat's executions go, and what is missing", () => {
    const text = chatContext({
      today,
      project,
      computingUnit: unit,
      unavailable: [{ name: "biomcp", uri: "texera://mcp-servers/b", reason: "connect ECONNREFUSED" }],
    });
    expect(text.split("\n")).toEqual([
      "## This chat",
      "Today is 2026-11-05.",
      where,
      `Computing unit: alice's unit (${unit.uri}). Compiles and runs in this chat use it unless a call names another.`,
      "Not available in this turn: the biomcp tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.",
    ]);
  });

  test("with no unit to fall back on, it says a call has to name one", () => {
    expect(chatContext({ today, project, unavailable: [] }).split("\n")).toEqual([
      "## This chat",
      "Today is 2026-11-05.",
      where,
      "No computing unit is set: a call that compiles or runs has to name one, from list_computing_units.",
    ]);
  });

  test("names every server that is missing", () => {
    const text = chatContext({
      today,
      project,
      computingUnit: unit,
      unavailable: [
        { name: "biomcp", uri: "a", reason: "x" },
        { name: "lab tools", uri: "b", reason: "y" },
      ],
    });
    expect(text).toContain("the biomcp and lab tools tools");
  });
});
