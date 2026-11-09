import { describe, expect, it } from "vitest";
import { type ScrollPoint, staysPinned } from "./chat-scroll";

const at = (top: number, height: number): ScrollPoint => ({ top, height, client: 700 });

describe("a chat following its end", () => {
  it("is at its end when near it, whatever it was doing", () => {
    expect(staysPinned(false, at(1000, 2000), at(1290, 2000))).toBe(true);
  });

  it("keeps following when its own move arrives after the messages grew", () => {
    expect(staysPinned(true, at(0, 0), at(4000, 5000))).toBe(true);
  });

  it("stops following when the reader moves up", () => {
    expect(staysPinned(true, at(4000, 5000), at(3000, 5000))).toBe(false);
  });

  it("keeps following when the browser moves it up because the content shrank", () => {
    expect(staysPinned(true, at(4000, 5000), at(3500, 4600))).toBe(true);
  });

  it("does not start following again until the reader is back at the end", () => {
    expect(staysPinned(false, at(3000, 5000), at(3100, 5000))).toBe(false);
  });
});
