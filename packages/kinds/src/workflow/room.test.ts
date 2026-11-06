import { CARD } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import { roomFor } from "./room";

// Cards of one column, 128 apart, and one beside them in the next column.
const drawn = {
  open: { x: 40, y: 40 },
  under: { x: 40, y: 168 },
  further: { x: 40, y: 296 },
  beside: { x: 360, y: 168 },
  above: { x: 40, y: -88 },
};

describe("the room a card open for editing makes", () => {
  it("moves what lies under it, in its column, down just as far as the open card reaches", () => {
    const room = roomFor(drawn, { id: "open", width: 296, height: 400 });
    // The open card ends at 440; the card under it starts the gap after that.
    expect(room.under).toBe(40 + 400 + 32 - 168);
    // What is further down moves with it, so the column keeps its order and its spacing.
    expect(room.further).toBe(room.under);
  });

  it("moves nothing beside it or above it", () => {
    const room = roomFor(drawn, { id: "open", width: 296, height: 400 });
    expect(room.beside).toBeUndefined();
    expect(room.above).toBeUndefined();
    expect(room.open).toBeUndefined();
  });

  it("moves nothing while the open card fits where it was", () => {
    expect(roomFor(drawn, { id: "open", width: CARD.width, height: 80 })).toEqual({});
  });

  it("is nothing for a card that is not on the canvas", () => {
    expect(roomFor(drawn, { id: "gone", width: 296, height: 400 })).toEqual({});
  });
});
