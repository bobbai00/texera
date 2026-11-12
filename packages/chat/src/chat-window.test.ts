import { describe, expect, it } from "vitest";
import { type ChatWindow, DEFAULT_WINDOW, fitted, handlePlace, hasThePage, inner, moved, placed, resized, taken } from "./chat-window";

const page = { width: 1400, height: 900, bar: 45 };

describe("how the chat's window fits its page", () => {
  it("stands as the person left it when there is room", () => {
    expect(fitted(DEFAULT_WINDOW, page)).toEqual(DEFAULT_WINDOW);
    const left: ChatWindow = { width: 600, top: 40, bottom: 200, side: "left", away: 100 };
    expect(fitted(left, page)).toEqual(left);
  });

  it("gives way to what it stands over, and never gets too small to use", () => {
    expect(fitted(DEFAULT_WINDOW, { ...page, width: 760 })?.width).toBe(356);
    expect(fitted({ ...DEFAULT_WINDOW, width: 100 }, page)?.width).toBe(320);
    // Too far from its side for the smallest window to leave room: it comes back.
    expect(fitted({ ...DEFAULT_WINDOW, away: 900 }, page)).toMatchObject({ away: 688, width: 320 });
    expect(fitted({ ...DEFAULT_WINDOW, side: "left", away: 900 }, page)).toMatchObject({ side: "left", away: 688, width: 320 });
  });

  it("stays below the page's bar and on the page, as tall as the page allows at least", () => {
    expect(fitted({ ...DEFAULT_WINDOW, top: -30, bottom: -5 }, page)).toMatchObject({ top: 12, bottom: 12 });
    expect(fitted({ ...DEFAULT_WINDOW, top: 700, bottom: 400 }, page)).toMatchObject({ top: 563, bottom: 12 });
    expect(fitted({ ...DEFAULT_WINDOW, top: 300 }, { ...page, height: 300 })).toMatchObject({ top: 12, bottom: 12 });
  });

  it("does not stand over a page too narrow for both", () => {
    expect(fitted(DEFAULT_WINDOW, { ...page, width: 700 })).toBeUndefined();
    expect(fitted(DEFAULT_WINDOW, { ...page, width: 0 })).toBeUndefined();
  });

  it("takes its width, its grip's room and what is between it and its side from the page", () => {
    expect(taken(DEFAULT_WINDOW)).toBe(504);
    expect(taken({ ...DEFAULT_WINDOW, side: "left", away: 40 })).toBe(532);
  });
});

describe("an edge of the chat's window taken by the pointer", () => {
  const w: ChatWindow = { width: 480, top: 12, bottom: 12, side: "right", away: 112 };

  it("moves that side alone", () => {
    expect(resized(w, "left", -150, 0, page)).toEqual({ ...w, width: 630 });
    expect(resized(w, "right", 60, 0, page)).toEqual({ ...w, away: 52, width: 540 });
    expect(resized(w, "top", 0, 200, page)).toEqual({ ...w, top: 212 });
    expect(resized(w, "bottom", 0, -300, page)).toEqual({ ...w, bottom: 312 });
  });

  it("moves both sides of a corner", () => {
    expect(resized(w, "top-left", -20, 30, page)).toEqual({ ...w, width: 500, top: 42 });
    expect(resized(w, "bottom-right", 40, -50, page)).toEqual({ ...w, away: 72, width: 520, bottom: 62 });
  });

  it("stops where the window would leave the page or its place below the bar", () => {
    expect(resized(w, "right", 500, 0, page)).toEqual({ ...w, away: 12, width: 580 });
    expect(resized(w, "top", 0, -500, page)).toEqual(w);
    expect(resized(w, "bottom", 0, 500, page)).toEqual(w);
  });

  it("stops where the window would be too small, or leave too little beside it", () => {
    expect(resized(w, "left", 400, 0, page).width).toBe(320);
    expect(resized(w, "right", -400, 0, page)).toEqual({ ...w, away: 272, width: 320 });
    expect(resized(w, "top", 0, 2000, page).top).toBe(563);
    expect(resized(w, "bottom", 0, -2000, page).bottom).toBe(563);
    expect(resized(w, "left", -2000, 0, page).width).toBe(896);
  });

  it("does the same, mirrored, for a window at the page's left", () => {
    const l: ChatWindow = { ...w, side: "left" };
    // Its right side faces the graph, and its left side the page's edge.
    expect(inner(l)).toBe("right");
    expect(resized(l, "right", 150, 0, page)).toEqual({ ...l, width: 630 });
    expect(resized(l, "left", -60, 0, page)).toEqual({ ...l, away: 52, width: 540 });
    expect(resized(l, "left", -500, 0, page)).toEqual({ ...l, away: 12, width: 580 });
    expect(resized(l, "right", 2000, 0, page).width).toBe(896);
    expect(resized(l, "top-right", 20, 30, page)).toEqual({ ...l, width: 500, top: 42 });
  });
});

describe("the chat's window taken by its header", () => {
  const w: ChatWindow = { width: 480, top: 100, bottom: 200, side: "right", away: 12 };

  it("goes where the pointer takes it, the size it was", () => {
    expect(moved(w, -200, 50, page)).toEqual({ ...w, away: 212, top: 150, bottom: 150 });
    expect(moved(w, -200, -50, page)).toEqual({ ...w, away: 212, top: 50, bottom: 250 });
  });

  it("stays on the page, below its bar", () => {
    expect(moved(w, 300, 0, page)).toEqual(w);
    expect(moved(w, 0, -500, page)).toEqual({ ...w, top: 12, bottom: 288 });
    expect(moved(w, 0, 500, page)).toEqual({ ...w, top: 288, bottom: 12 });
  });

  it("stands at the side of the page it is nearer to", () => {
    // Its middle past the page's: the left side is the nearer one.
    expect(moved(w, -700, 0, page)).toEqual({ ...w, side: "left", away: 208 });
    expect(moved(w, -5000, 0, page)).toEqual({ ...w, side: "left", away: 12 });
    expect(moved({ ...w, side: "left", away: 12 }, 5000, 0, page)).toEqual(w);
  });

  it("leaves what it stands over room on its other side", () => {
    // On a page of 1000 the window of 480 can be 128 from its side at most.
    const narrow = { ...page, width: 1000 };
    expect(moved(w, -200, 0, narrow)).toEqual({ ...w, away: 128 });
    expect(moved(w, -248, 0, narrow)).toEqual({ ...w, away: 128 });
    expect(moved(w, -249, 0, narrow)).toEqual({ ...w, side: "left", away: 128 });
    expect(moved(w, -400, 0, narrow)).toEqual({ ...w, side: "left", away: 108 });
  });
});

describe("where the window and its handles stand", () => {
  const right = { top: 57, bottom: 12, width: 480, side: "right", away: 12 } as const;
  const left = { ...right, side: "left" } as const;

  it("is from the window's own side of the page", () => {
    expect(placed(right)).toEqual({ top: 57, bottom: 12, width: 480, right: 12 });
    expect(placed(left)).toEqual({ top: 57, bottom: 12, width: 480, left: 12 });
  });

  it("has the grip on the side that faces the graph, in the room the window keeps there", () => {
    expect(handlePlace("left", right)).toEqual({ top: 71, bottom: 26, right: 492, width: 12 });
    expect(handlePlace("right", left)).toEqual({ top: 71, bottom: 26, left: 492, width: 12 });
  });

  it("has the other handles around the window's rim", () => {
    expect(handlePlace("right", right)).toEqual({ top: 71, bottom: 26, right: 6, width: 8 });
    expect(handlePlace("left", left)).toEqual({ top: 71, bottom: 26, left: 6, width: 8 });
    expect(handlePlace("top", right)).toEqual({ top: 51, right: 26, width: 452, height: 8 });
    expect(handlePlace("bottom-left", right)).toEqual({ bottom: 6, right: 484, width: 14, height: 14 });
    expect(handlePlace("bottom-left", left)).toEqual({ bottom: 6, left: 6, width: 14, height: 14 });
    expect(handlePlace("top-right", left)).toEqual({ top: 51, left: 484, width: 14, height: 14 });
  });
});

describe("a chat given the whole page", () => {
  it("has it while the graph under it says what it said then", () => {
    expect(hasThePage("a plan", "a plan")).toBe(true);
  });

  it("gives it back when the graph has something new to show", () => {
    expect(hasThePage("a plan", "a plan, and a workflow made")).toBe(false);
  });

  it("is a window beside a graph until the person gives it the page", () => {
    expect(hasThePage(undefined, "a plan")).toBe(false);
    expect(hasThePage(undefined, undefined)).toBe(false);
  });
});
