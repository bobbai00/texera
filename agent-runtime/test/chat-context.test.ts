import { describe, expect, test } from "bun:test";
import { chatContext } from "../src/agent/chat-context.ts";

const today = new Date("2026-11-05T23:30:00Z");
const unit = {
  uri: "texera://computing-units/11111111-1111-4111-8111-111111111111",
  name: "alice's unit",
  phase: "ready",
};

describe("chatContext", () => {
  test("says the date, where this chat's runs go, and what is missing", () => {
    const text = chatContext({
      today,
      chat: { computingUnit: unit },
      unavailable: [{ name: "biomcp", uri: "texera://mcp-servers/b", reason: "connect ECONNREFUSED" }],
    });
    expect(text.split("\n")).toEqual([
      "## This chat",
      "Today is 2026-11-05.",
      `Computing unit: alice's unit (${unit.uri}), ready. Compiles and runs in this chat use it unless a call names another.`,
      "Not available in this turn: the biomcp tools (the server could not be reached). Say so if the person asks for them; do not answer from memory in their place.",
    ]);
  });

  test("with no unit picked and everything mounted, it says the date alone", () => {
    expect(chatContext({ today, chat: {}, unavailable: [] })).toBe("## This chat\nToday is 2026-11-05.");
    expect(chatContext({ today, unavailable: [] })).toBe("## This chat\nToday is 2026-11-05.");
  });

  test("a unit that is not ready is said to be so, and one whose state is unknown says nothing of it", () => {
    expect(chatContext({ today, chat: { computingUnit: { ...unit, phase: "pending" } }, unavailable: [] })).toContain(
      "), pending. ",
    );
    expect(
      chatContext({ today, chat: { computingUnit: { uri: unit.uri, name: "a unit" } }, unavailable: [] }),
    ).toContain(`a unit (${unit.uri}). Compiles`);
  });

  test("names every server that is missing", () => {
    const text = chatContext({
      today,
      unavailable: [
        { name: "biomcp", uri: "a", reason: "x" },
        { name: "lab tools", uri: "b", reason: "y" },
      ],
    });
    expect(text).toContain("the biomcp and lab tools tools");
  });
});
