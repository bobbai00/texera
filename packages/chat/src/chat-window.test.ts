import { describe, expect, it } from "vitest";
import { CHAT_DEFAULT_WIDTH, widthIn } from "./chat-window";

describe("how wide the chat stands", () => {
  it("is what the person asked for when there is room", () => {
    expect(widthIn(1400, CHAT_DEFAULT_WIDTH)).toBe(CHAT_DEFAULT_WIDTH);
  });

  it("gives way to what is beside it, and never gets too small to use", () => {
    expect(widthIn(760, 480)).toBe(356);
    expect(widthIn(1400, 100)).toBe(320);
  });

  it("does not stand beside anything on a page too narrow for both", () => {
    expect(widthIn(700, 480)).toBeUndefined();
    expect(widthIn(0, 480)).toBeUndefined();
  });
});
