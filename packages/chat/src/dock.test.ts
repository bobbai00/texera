import { describe, expect, it } from "vitest";
import { dockChat, withDockChat } from "./dock";

describe("the chat a page's dock continues", () => {
  it("is the one last used on that page, when there is one", () => {
    const preferences = { project: "p", dock: { w1: "c1", w2: "c2" } };
    expect(dockChat(preferences, "w1")).toBe("c1");
    expect(dockChat(preferences, "w3")).toBeUndefined();
    expect(dockChat({}, "w1")).toBeUndefined();
    expect(dockChat({ dock: "nonsense" }, "w1")).toBeUndefined();
    expect(dockChat({ dock: { w1: 7 } }, "w1")).toBeUndefined();
  });

  it("is remembered beside the person's other preferences", () => {
    expect(withDockChat({ project: "p", dock: { w1: "c1" } }, "w2", "c2")).toEqual({ project: "p", dock: { w1: "c1", w2: "c2" } });
    expect(withDockChat({}, "w1", "c1")).toEqual({ dock: { w1: "c1" } });
  });

  it("is forgotten when the page starts over", () => {
    expect(withDockChat({ dock: { w1: "c1", w2: "c2" } }, "w1", undefined)).toEqual({ dock: { w2: "c2" } });
  });

  it("keeps the pages used most recently, so the preferences do not grow without end", () => {
    let preferences: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) preferences = withDockChat(preferences, `w${i}`, `c${i}`);
    // A page used again counts as recent.
    preferences = withDockChat(preferences, "w10", "c10b");
    const dock = preferences.dock as Record<string, string>;
    expect(Object.keys(dock).length).toBe(50);
    expect(dock.w10).toBe("c10b");
    expect(dock.w59).toBe("c59");
    expect(dock.w0).toBeUndefined();
  });
});
