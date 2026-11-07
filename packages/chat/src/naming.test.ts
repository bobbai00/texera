import { describe, expect, it } from "vitest";
import { chatName } from "./naming";

const started = new Date(2026, 10, 5, 14, 20, 31);

describe("the name a chat starts with", () => {
  it("says when it started, and what it is about when it was started beside a page", () => {
    expect(chatName(undefined, started)).toBe("Chat, Nov 5, 02:20:31 PM");
    expect(chatName("iris", started)).toBe("About iris, Nov 5, 02:20:31 PM");
  });
});
