import { describe, expect, test } from "bun:test";
import { composeSystemPrompt } from "../src/agent/system-prompt.ts";
import type { TemplateRecord } from "../src/catalog/types.ts";

const template = (prompt?: string) =>
  ({
    spec: { card: { name: "Mine", description: "does things" }, ...(prompt ? { prompt } : {}) },
  }) as unknown as TemplateRecord;

describe("what every agent is told", () => {
  test("how a chat shows resources, after an agent's own prompt", () => {
    const system = composeSystemPrompt(template("Be brief."), [], []);
    expect(system.startsWith("Be brief.")).toBe(true);
    expect(system).toContain("A URI alone on a line is the resource's card");
  });

  test("the same for an agent with no prompt of its own", () => {
    expect(composeSystemPrompt(template(), [], [])).toContain("A URI alone on a line is the resource's card");
  });
});
