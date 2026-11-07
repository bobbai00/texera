import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE, fitted, moved, resized, TITLE_HEIGHT } from "./results-window";

const canvas = { width: 1100, height: 700 };

describe("where the results window sits over the canvas", () => {
  it("starts at the bottom left, within the canvas", () => {
    expect(fitted(DEFAULT_PLACE, canvas)).toEqual(DEFAULT_PLACE);
  });

  it("moves with the pointer by its title bar and never leaves the canvas", () => {
    const w = fitted(moved(DEFAULT_PLACE, 100, -50), canvas);
    expect([w.left, w.bottom]).toEqual([116, 66]);
    const far = fitted(moved(DEFAULT_PLACE, 5000, -5000), canvas);
    expect(far.left + far.width).toBeLessThanOrEqual(canvas.width - 8);
    expect(far.bottom + far.height).toBeLessThanOrEqual(canvas.height - 8);
    expect(fitted(moved(DEFAULT_PLACE, -500, 500), canvas)).toMatchObject({ left: 8, bottom: 8 });
  });

  it("is sized by its top right corner, the bottom left staying put, within limits", () => {
    const w = fitted(resized(DEFAULT_PLACE, 80, -40), canvas);
    expect(w).toMatchObject({ left: 16, bottom: 16, width: 800, height: 360 });
    expect(fitted(resized(DEFAULT_PLACE, -2000, 2000), canvas)).toMatchObject({ width: 360, height: 180 });
    expect(fitted(resized(DEFAULT_PLACE, 4000, -4000), canvas)).toMatchObject({
      width: canvas.width - 16,
      height: canvas.height - 16,
    });
  });

  it("folded to its title bar, it may go as high as the bar fits", () => {
    const w = fitted({ ...DEFAULT_PLACE, folded: true, bottom: 10_000 }, canvas);
    expect(w.bottom).toBe(canvas.height - TITLE_HEIGHT - 8);
  });

  it("on a canvas smaller than the smallest window, fills what there is", () => {
    const w = fitted(DEFAULT_PLACE, { width: 300, height: 150 });
    expect(w).toMatchObject({ left: 8, bottom: 8, width: 284, height: 134 });
  });
});
