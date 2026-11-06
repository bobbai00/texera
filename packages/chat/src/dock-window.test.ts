import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW, fitted, moved, resized } from "./dock-window";

const screen = { width: 1280, height: 720 };

describe("the chat window beside a page", () => {
  it("starts at the bottom right, as big as it was before it could be changed", () => {
    expect(fitted(DEFAULT_WINDOW, screen)).toEqual({ right: 16, bottom: 16, width: 416, height: 640 });
  });

  it("moves with the pointer that holds its header, and stays on screen", () => {
    expect(fitted(moved(DEFAULT_WINDOW, -300, -40), screen)).toEqual({
      right: 316,
      bottom: 56,
      width: 416,
      height: 640,
    });
    // Dragged past the left and the top edges, it stops at them.
    expect(fitted(moved(DEFAULT_WINDOW, -5000, -5000), screen)).toEqual({
      right: 1280 - 416 - 8,
      bottom: 720 - 640 - 8,
      width: 416,
      height: 640,
    });
    // And past the right and the bottom ones.
    expect(fitted(moved(DEFAULT_WINDOW, 5000, 5000), screen)).toEqual({ right: 8, bottom: 8, width: 416, height: 640 });
  });

  it("grows from its top left corner, the bottom right one staying put, within the screen and no smaller than usable", () => {
    expect(fitted(resized(DEFAULT_WINDOW, -100, 100), screen)).toEqual({
      right: 16,
      bottom: 16,
      width: 516,
      height: 540,
    });
    expect(fitted(resized(DEFAULT_WINDOW, 1000, 1000), screen)).toMatchObject({ width: 320, height: 360 });
    expect(fitted(resized(DEFAULT_WINDOW, -5000, -5000), screen)).toMatchObject({
      width: 1280 - 16,
      height: 720 - 16,
      right: 8,
      bottom: 8,
    });
  });

  it("fits a smaller screen than the one it was left on", () => {
    expect(fitted({ right: 900, bottom: 500, width: 600, height: 700 }, { width: 800, height: 600 })).toEqual({
      right: 192,
      bottom: 8,
      width: 600,
      height: 584,
    });
  });
});
