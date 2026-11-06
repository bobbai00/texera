import { ORIGIN, ROW } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import { createCanvasView, portKey } from "./canvas-view";
import { rowSpread, spread, unspread } from "./density";

describe("how a canvas is looked at", () => {
  it("starts with every card saying its settings in one line, nothing open and no result on screen", () => {
    const view = createCanvasView().getState();
    expect(view).toMatchObject({ density: "compact", editing: null, result: null });
    expect(view.flipped.size).toBe(0);
  });

  it("lets one card say more or less than the rest, until the choice for all changes", () => {
    const view = createCanvasView();
    view.getState().flip("avg");
    expect(view.getState().flipped.has("avg")).toBe(true);
    view.getState().flip("avg");
    expect(view.getState().flipped.has("avg")).toBe(false);
    view.getState().flip("scan");
    view.getState().setDensity("detailed");
    expect(view.getState().density).toBe("detailed");
    expect(view.getState().flipped.size).toBe(0);
    view.getState().setDensity("compact");
  });

  it("keeps the map of a large workflow closed until the viewer opens it, and remembers that", () => {
    const view = createCanvasView();
    expect(view.getState().map).toBe(false);
    view.getState().setMap(true);
    expect(view.getState().map).toBe(true);
    // The next canvas the viewer opens has it too.
    expect(createCanvasView().getState().map).toBe(true);
    view.getState().setMap(false);
    expect(createCanvasView().getState().map).toBe(false);
  });

  it("has one card open and one result on screen at a time", () => {
    const view = createCanvasView();
    view.getState().edit("scan");
    view.getState().edit("avg");
    expect(view.getState().editing).toBe("avg");
    view.getState().show(portKey("avg", "output-0"));
    expect(view.getState().result).toBe("avg:output-0");
    view.getState().show(null);
    expect(view.getState().result).toBeNull();
  });
});

describe("the room cards take", () => {
  it("is what the layout gives them while they say their settings in one line", () => {
    expect(rowSpread(0)).toBe(1);
    expect(rowSpread(64)).toBe(1);
    // A card with the line that says how it did in an execution still fits in its row.
    expect(rowSpread(96)).toBe(1);
  });

  it("grows with the tallest card, so none lies on the one under it", () => {
    const k = rowSpread(220);
    expect(k).toBeGreaterThan(1);
    // Two cards one row apart are drawn further apart than the tallest is high.
    expect(k * ROW).toBeGreaterThan(220);
  });

  it("moves rows apart from the canvas's origin and leaves columns where they are", () => {
    const places = { a: { x: 40, y: ORIGIN.y }, b: { x: 376, y: ORIGIN.y + ROW } };
    const drawn = spread(places, 2);
    expect(drawn.a).toEqual({ x: 40, y: ORIGIN.y });
    expect(drawn.b).toEqual({ x: 376, y: ORIGIN.y + 2 * ROW });
    expect(spread(places, 1)).toBe(places);
  });

  it("keeps the place of a card moved while rows are apart as the place it has when they are not", () => {
    const at = { x: 500, y: ORIGIN.y + 300 };
    expect(unspread(at, 2)).toEqual({ x: 500, y: ORIGIN.y + 150 });
    expect(spread({ a: unspread(at, 1.5) }, 1.5).a).toEqual(at);
    expect(unspread(at, 1)).toBe(at);
  });
});
