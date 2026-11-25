/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, it } from "vitest";
import {
  type CardChips,
  drawnPlaces,
  keptPlaces,
  type OpenCard,
  operatorCard,
  operatorSpacing,
  resourceChipPlaces,
  resultChip,
  resultChipPlaces,
  roomFor,
  rowSpread,
  type Size,
  spread,
} from "./canvas-geometry";
import type { Point } from "./model";

/** A card open for editing: wider than a closed card, and tall with its settings. */
const opened = { width: 296, height: 400 };

/** Whether two boxes, each placed by its top left corner, lie over each other. */
const overlap = (p: Point, a: Size, q: Point, b: Size) =>
  p.x < q.x + b.width && q.x < p.x + a.width && p.y < q.y + b.height && q.y < p.y + a.height;

describe("resourceChipPlaces", () => {
  it("stands the chips of what an operator reads above its card, centered on it, each next one higher", () => {
    // A chip is 200 wide and 36 high, 22 above what is under it.
    expect(resourceChipPlaces({ x: 40, y: 200 }, operatorCard, 2)).toEqual([
      { x: 64, y: 142 },
      { x: 64, y: 84 },
    ]);
  });

  it("centers them on a card drawn wider, as one open for editing is", () => {
    expect(resourceChipPlaces({ x: 40, y: 200 }, opened, 1)).toEqual([{ x: 88, y: 142 }]);
  });

  it("has no chips for an operator that reads nothing", () => {
    expect(resourceChipPlaces({ x: 40, y: 200 }, operatorCard, 0)).toEqual([]);
    expect(resourceChipPlaces({ x: 40, y: 200 }, operatorCard, -1)).toEqual([]);
  });
});

describe("resultChipPlaces", () => {
  it("stands the first result under the card's right edge, where its outputs are, and the next one to its left", () => {
    // A chip is 116 wide and 30 high, 22 under the card, 8 from the one beside it.
    expect(resultChipPlaces({ x: 0, y: 100 }, operatorCard.height, 2)).toEqual([
      { x: 190, y: 186 },
      { x: 66, y: 186 },
    ]);
  });

  it("stands them under the card as tall as it is drawn", () => {
    expect(resultChipPlaces({ x: 0, y: 100 }, 90, 1)).toEqual([{ x: 190, y: 212 }]);
  });

  it("stands two results to a line, so that none reaches past the card's left side", () => {
    const places = resultChipPlaces({ x: 0, y: 100 }, operatorCard.height, 5);

    // The next line is 8 under the one before.
    expect(places).toEqual([
      { x: 190, y: 186 },
      { x: 66, y: 186 },
      { x: 190, y: 224 },
      { x: 66, y: 224 },
      { x: 190, y: 262 },
    ]);
    expect(Math.min(...places.map(({ x }) => x))).toBeGreaterThanOrEqual(0);
  });

  it("keeps the results of a card drawn wider, as one open for editing is, in its own column", () => {
    const [place] = resultChipPlaces({ x: 0, y: 0 }, opened.height, 1);

    expect(place).toEqual({ x: 190, y: 422 });
    expect(place.x + resultChip.width).toBeLessThan(operatorSpacing.column);
  });

  it("has no chips for an operator without results", () => {
    expect(resultChipPlaces({ x: 0, y: 100 }, operatorCard.height, 0)).toEqual([]);
  });
});

describe("roomFor", () => {
  // Cards of one column, a row apart, one beside them in the next column, and one above.
  const drawn = {
    open: { x: 40, y: 40 },
    under: { x: 40, y: 168 },
    further: { x: 40, y: 296 },
    beside: { x: 360, y: 168 },
    above: { x: 40, y: -88 },
  };
  const open: OpenCard = { id: "open", ...opened };

  it("moves what lies under the open card, in its column, down just as far as the open card reaches", () => {
    const room = roomFor(drawn, open);

    // The open card ends at 440; the card under it starts 32 after that.
    expect(room.under).toBe(40 + 400 + 32 - 168);
    // What is further down moves with it, so the column keeps its order and its spacing.
    expect(room.further).toBe(room.under);
  });

  it("moves nothing beside the open card or above it, nor the open card itself", () => {
    expect(Object.keys(roomFor(drawn, open)).toSorted()).toEqual(["further", "under"]);
  });

  it("moves nothing while the open card fits where it was", () => {
    expect(roomFor(drawn, { id: "open", width: operatorCard.width, height: 80 })).toEqual({});
  });

  it("makes no room for a card that is not on the canvas", () => {
    expect(roomFor(drawn, { id: "gone", ...opened })).toEqual({});
  });

  it("makes room for the results under the open card, two to a line", () => {
    const room = roomFor(drawn, open, { open: { results: 2 } });

    // Two results stand side by side, in one line 22 under the card and 30 high.
    expect(room.under).toBe(40 + 400 + 22 + 30 + 32 - 168);
    expect(room.further).toBe(room.under);
    // A third stands on a second line, 8 under the first.
    expect(roomFor(drawn, open, { open: { results: 3 } }).under).toBe(40 + 400 + 22 + 30 + 8 + 30 + 32 - 168);
  });

  it("makes no room for the chips above the open card, which stand where they stood", () => {
    expect(roomFor(drawn, open, { open: { resources: 3 } })).toEqual({ under: 304, further: 304 });
  });

  it("makes room for the chips above the cards under the open card, and not for their own results", () => {
    const room = roomFor(drawn, open, { under: { resources: 2, results: 1 } });

    // The two chips above the card under it start 2 * (36 + 22) above it.
    expect(room.under).toBe(40 + 400 + 32 - (168 - 116));
    expect(room.further).toBe(room.under);
  });

  it("makes room for the results of the open card and the chips above the card under it together", () => {
    const room = roomFor(drawn, open, { open: { results: 1 }, under: { resources: 1 } });

    expect(room.under).toBe(40 + 400 + 22 + 30 + 32 - (168 - 58));
    expect(room.further).toBe(room.under);
  });

  it("moves a card that reaches into the open card's column, and not one that only touches it", () => {
    const edges = {
      open: { x: 40, y: 40 },
      fromLeft: { x: 40 - operatorCard.width + 1, y: 168 },
      fromRight: { x: 40 + opened.width - 1, y: 168 },
      touchingLeft: { x: 40 - operatorCard.width, y: 168 },
      touchingRight: { x: 40 + opened.width, y: 168 },
    };

    expect(Object.keys(roomFor(edges, open)).toSorted()).toEqual(["fromLeft", "fromRight"]);
  });

  it("leaves the card one column on where it is, clear of the results of the open card", () => {
    // Three rows down in the next column: as low as the results under the open card stand.
    const next = { x: 40 + operatorSpacing.column, y: 40 + 3 * operatorSpacing.row };
    const [result] = resultChipPlaces(drawn.open, opened.height, 1);

    expect(roomFor({ ...drawn, next }, open, { open: { results: 1 } }).next).toBeUndefined();
    expect(overlap(result, resultChip, next, operatorCard)).toBe(false);
    // It stands as low as the result, so it would lie under the result were the result in its column.
    expect(overlap({ ...result, x: next.x }, resultChip, next, operatorCard)).toBe(true);
  });
});

describe("rowSpread", () => {
  it("keeps the rows as they are while every card says its settings in one line", () => {
    expect(rowSpread(0)).toBe(1);
    expect(rowSpread(64)).toBe(1);
    // A card with the line that says how it did in an execution still fits in its row.
    expect(rowSpread(96)).toBe(1);
  });

  it("draws the rows further apart for a taller card, so that it does not lie on the one under it", () => {
    expect(rowSpread(220)).toBe(2);
    expect(rowSpread(220) * 128).toBeGreaterThanOrEqual(220 + 32);
  });

  it("goes in eighths, so that a pixel more or less on one card does not move the whole canvas", () => {
    expect(rowSpread(97)).toBe(1.125);
    expect(rowSpread(100)).toBe(1.125);
  });

  it("makes room for the chips above the cards and the results under them", () => {
    expect(rowSpread(64, { resources: 1 })).toBe(1.25);
    expect(rowSpread(64, { results: 2 })).toBe(1.25);
    // A third result stands on a second line.
    expect(rowSpread(64, { results: 3 })).toBe(1.5);
    expect(rowSpread(64, { resources: 2, results: 1 })).toBe(2.125);
  });

  it("keeps the rows as they are for a height that is not a size", () => {
    expect(rowSpread(Number.NaN)).toBe(1);
    expect(rowSpread(-50)).toBe(1);
  });
});

describe("spread", () => {
  it("draws each row k times as far from the top of the canvas, and leaves the columns where they are", () => {
    const places = { a: { x: 40, y: 0 }, b: { x: 360, y: 128 }, c: { x: 40, y: -64 } };

    expect(spread(places, 2)).toEqual({ a: { x: 40, y: 0 }, b: { x: 360, y: 256 }, c: { x: 40, y: -128 } });
  });

  it("gives the places themselves while the rows are as far apart as they are kept", () => {
    const places = { a: { x: 40, y: 128 } };

    expect(spread(places, 1)).toBe(places);
  });
});

/** Where cards kept at `kept` are drawn while the rows are `k` times further apart and `open` is open for editing. */
function drawnAt(kept: Record<string, Point>, k: number, open: OpenCard, chips: Record<string, CardChips> = {}) {
  const drawn = spread(kept, k);
  const room = roomFor(drawn, open, chips);
  return Object.fromEntries(Object.entries(drawn).map(([id, { x, y }]) => [id, { x, y: y + (room[id] ?? 0) }]));
}

describe("keptPlaces", () => {
  // A column under the open card, a row apart, and a card beside it in the next column. With the card open, the
  // column under it is drawn 400 + 32 - 128 = 304 lower: the card under it at 432, the one further down at 560.
  const kept = {
    open: { x: 0, y: 0 },
    under: { x: 0, y: 128 },
    further: { x: 0, y: 256 },
    beside: { x: 320, y: 128 },
  };
  const open: OpenCard = { id: "open", ...opened };
  /** Where the cards are drawn once the moved ones are kept at their new places. */
  const after = (moved: Record<string, Point>, k = 1) => drawnAt({ ...kept, ...moved }, k, open);

  it("keeps a card moved while the rows are drawn apart at the place it has when they are not", () => {
    expect(keptPlaces({ beside: { x: 500, y: 300 } }, 2, spread(kept, 2))).toEqual({ beside: { x: 500, y: 150 } });
    expect(keptPlaces({ beside: { x: 500, y: 300 } }, 1, kept)).toEqual({ beside: { x: 500, y: 300 } });
  });

  it.each<[number, Record<string, CardChips>]>([
    [1, {}],
    [1.25, {}],
    [1, { open: { results: 1 }, under: { resources: 1 } }],
  ])("keeps every card at its place when it is dropped where it is drawn (rows %s apart, chips %o)", (k, chips) => {
    expect(keptPlaces(drawnAt(kept, k, open, chips), k, spread(kept, k), open, chips)).toEqual(kept);
  });

  it("keeps a card dragged out from under the open card where it was dropped, where nothing is drawn lower", () => {
    const moved = keptPlaces({ under: { x: 640, y: 432 } }, 1, kept, open);

    expect(moved).toEqual({ under: { x: 640, y: 432 } });
    expect(after(moved).under).toEqual({ x: 640, y: 432 });
  });

  it("keeps a card dropped beside the open card at its place with the rows as they are kept", () => {
    const k = 1.5;
    const moved = keptPlaces({ under: { x: 640, y: 432 } }, k, spread(kept, k), open);

    expect(moved).toEqual({ under: { x: 640, y: 432 / k } });
    expect(after(moved, k).under).toEqual({ x: 640, y: 432 });
  });

  it("keeps a card moved under the open card as much higher as the cards there are drawn lower", () => {
    const moved = keptPlaces({ further: { x: 0, y: 600 } }, 1, kept, open);

    expect(moved).toEqual({ further: { x: 0, y: 600 - 304 } });
    expect(after(moved).further).toEqual({ x: 0, y: 600 });
  });

  it("keeps a card brought under the open card from beside it as much higher as the cards there are lower", () => {
    const moved = keptPlaces({ beside: { x: 0, y: 700 } }, 1, kept, open);

    expect(moved).toEqual({ beside: { x: 0, y: 700 - 304 } });
    expect(after(moved).beside).toEqual({ x: 0, y: 700 });
  });

  it("moves the card right under the open card as far as it was dragged, though it is drawn there still", () => {
    const moved = keptPlaces({ under: { x: 0, y: 437 } }, 1, kept, open);

    expect(moved).toEqual({ under: { x: 0, y: 133 } });
    // It is still the highest card under the open card, which stands the gap under it.
    expect(after(moved).under).toEqual({ x: 0, y: 432 });
  });

  it("keeps a card dropped on the open card under it, and draws it right under the open card", () => {
    // Dropped halfway down the 432 from the open card's top to where the cards under it start: kept half of the 304
    // higher, between the open card and the card under it.
    const moved = keptPlaces({ beside: { x: 0, y: 216 } }, 1, kept, open);
    const drawn = after(moved);

    expect(moved).toEqual({ beside: { x: 0, y: 64 } });
    expect(drawn.beside).toEqual({ x: 0, y: 432 });
    // The cards under it make room for it in turn.
    expect(drawn.under.y).toBeGreaterThanOrEqual(drawn.beside.y + operatorCard.height);
  });

  it("keeps a card dropped above the open card where it was dropped", () => {
    const moved = keptPlaces({ further: { x: 0, y: -200 } }, 1, kept, open);

    expect(moved).toEqual({ further: { x: 0, y: -200 } });
    expect(after(moved).further).toEqual({ x: 0, y: -200 });
  });

  it("keeps the open card where it was dropped, and the cards dragged with it at their places under it", () => {
    const moved = keptPlaces({ open: { x: 640, y: 0 }, under: { x: 640, y: 432 } }, 1, kept, open);

    expect(moved).toEqual({ open: { x: 640, y: 0 }, under: { x: 640, y: 128 } });
    expect(after(moved).under).toEqual({ x: 640, y: 432 });
    // The card left behind is no longer under the open card.
    expect(after(moved).further).toEqual({ x: 0, y: 256 });
  });

  it("keeps cards dropped while the open card is not on the canvas where they were dropped", () => {
    expect(keptPlaces({ under: { x: 0, y: 432 } }, 1, kept, { id: "gone", ...opened })).toEqual({
      under: { x: 0, y: 432 },
    });
  });
});

describe("drawnPlaces", () => {
  // The column of keptPlaces: with the card open, the cards under it are drawn 304 lower, from 432 on.
  const kept = {
    open: { x: 0, y: 0 },
    under: { x: 0, y: 128 },
    further: { x: 0, y: 256 },
    beside: { x: 320, y: 128 },
  };
  const open: OpenCard = { id: "open", ...opened };

  it("draws a place over a card under the open card as much lower as that card is drawn", () => {
    // Someone points 12 into the card under the open one: they point 12 into it here too.
    expect(drawnPlaces({ pointer: { x: 10, y: 140 } }, 1, kept, open)).toEqual({ pointer: { x: 10, y: 444 } });
    expect(drawnPlaces({ pointer: { x: 10, y: 300 } }, 1, kept, open).pointer).toEqual({ x: 10, y: 300 + 304 });
  });

  it("draws a place over the open card's own place on the open card, which takes the room down to the cards under it", () => {
    // A quarter of the way from the open card's top to the card under it, as the workflow keeps them: a quarter of
    // the way down the 432 to where that card is drawn.
    const { pointer } = drawnPlaces({ pointer: { x: 10, y: 32 } }, 1, kept, open);

    expect(pointer).toEqual({ x: 10, y: 108 });
    expect(pointer.y).toBeLessThan(opened.height);
  });

  it("draws a place beside the open card's column, or above it, where the rows put it", () => {
    expect(drawnPlaces({ beside: { x: 400, y: 140 }, above: { x: 10, y: -50 } }, 1, kept, open)).toEqual({
      beside: { x: 400, y: 140 },
      above: { x: 10, y: -50 },
    });
    expect(drawnPlaces({ beside: { x: 400, y: 140 } }, 2, spread(kept, 2), open)).toEqual({
      beside: { x: 400, y: 280 },
    });
  });

  it("draws places where the rows put them while no card is open, or the open one is not on the canvas", () => {
    expect(drawnPlaces({ pointer: { x: 10, y: 140 } }, 1.5, spread(kept, 1.5))).toEqual({
      pointer: { x: 10, y: 210 },
    });
    expect(drawnPlaces({ pointer: { x: 10, y: 140 } }, 1, kept, { id: "gone", ...opened })).toEqual({
      pointer: { x: 10, y: 140 },
    });
  });

  it.each<[number, Record<string, CardChips>]>([
    [1, {}],
    [1.25, {}],
    [1, { open: { results: 1 }, under: { resources: 1 } }],
  ])("draws a place where keptPlaces keeps it from (rows %s apart, chips %o)", (k, chips) => {
    const drawn = spread(kept, k);
    const places = {
      onOpen: { x: 30, y: 20 },
      inTheGap: { x: 100, y: 90 },
      onUnder: { x: 200, y: 150 },
      further: { x: 0, y: 400 },
      beside: { x: 500, y: 150 },
    };

    const back = keptPlaces(drawnPlaces(places, k, drawn, open, chips), k, drawn, open, chips);

    for (const [id, { x, y }] of Object.entries(places)) {
      expect(back[id].x).toBe(x);
      expect(back[id].y).toBeCloseTo(y);
    }
  });
});
