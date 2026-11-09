import { describe, expect, test } from "bun:test";
import { nameFrom, UNNAMED_CHAT } from "../src/agent/chat-name.ts";

describe("what a model's reply comes to as a chat's name", () => {
  test("is the reply, bare of what a model dresses it in", () => {
    expect(nameFrom("Diabetes screening models")).toBe("Diabetes screening models");
    expect(nameFrom('  "Readmission by HbA1c."\n')).toBe("Readmission by HbA1c");
    expect(nameFrom("**Pima cohort check**")).toBe("Pima cohort check");
    expect(nameFrom("# Retinal features")).toBe("Retinal features");
  });

  test("is its first line, cut at a word to fit a list", () => {
    expect(nameFrom("Kidney function\nHere is why I chose it")).toBe("Kidney function");
    const long = nameFrom(`${"word ".repeat(30)}`);
    expect(long?.length).toBeLessThanOrEqual(60);
    expect(long?.endsWith("word")).toBe(true);
  });

  test("is nothing when it says nothing", () => {
    expect(nameFrom("  ")).toBeUndefined();
    expect(nameFrom(UNNAMED_CHAT)).toBeUndefined();
  });
});
