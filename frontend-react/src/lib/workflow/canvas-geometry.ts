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

// Where the canvas draws what is not in the workflow's places: the chips of the datasets and models an operator
// reads, above its card, and of its results, under it; the rows further apart while cards are taller than the layout
// counts them; and the cards under a card open for editing lower, to make room for it. All of it is the viewer's own
// drawing: the workflow keeps the places it has with every card closed and saying its settings in one line, and a
// move writes those places (`keptPlaces`), never the drawn ones.

import type { Point } from "./model";

/** The size of a card as it is drawn. In pixels, as everything here. */
export interface Size {
  width: number;
  height: number;
}

/**
 * An operator on the canvas is a card, which its position places by its top left corner. This is its size as the
 * layout counts it: its width, and its height while it says its settings in one line.
 */
export const operatorCard = { width: 248, height: 64 };

/**
 * How far apart arranging puts operators, from one column to the next and from one row to the next: a card, the room
 * for the links between two columns, and under a card the line that says how it did in an execution.
 */
export const operatorSpacing = { column: operatorCard.width + 72, row: operatorCard.height + 64 };

/** The chip of a dataset or a model, above the card of an operator that reads it: its size, and the room under it. */
export const resourceChip = { width: 200, height: 36, gap: 22 };

/**
 * The chip of a result, under the card of the operator it came out of: its size, the room between it and the card,
 * the room between two chips side by side or one under the other, and how many stand side by side: two, as many as
 * fit under a card.
 */
export const resultChip = { width: 116, height: 30, gap: 22, apart: 8, perLine: 2 };

/** How many chips a card has: of the datasets and models it reads, above it, and of its results, under it. */
export interface CardChips {
  resources?: number;
  results?: number;
}

/** The least room between a card and what stands under it: the next card, or the chips above that card. */
const cardGap = 32;

/** How far above its card the chips of what an operator reads reach. */
const reachAbove = (chips: CardChips | undefined) =>
  Math.max(0, chips?.resources ?? 0) * (resourceChip.height + resourceChip.gap);

/** How far under its card the chips of its results reach, in as many lines as they take. */
function reachBelow(chips: CardChips | undefined): number {
  const lines = Math.ceil(Math.max(0, chips?.results ?? 0) / resultChip.perLine);
  return lines > 0 ? resultChip.gap + lines * resultChip.height + (lines - 1) * resultChip.apart : 0;
}

/**
 * Where the chips of the datasets and models an operator reads stand, by the top left corner of each: above its card,
 * centered on it, the first nearest to it and each next one above the one before.
 */
export function resourceChipPlaces(at: Point, card: Size, count: number): Point[] {
  return Array.from({ length: count }, (_, index) => ({
    x: at.x + (card.width - resourceChip.width) / 2,
    y: at.y - (index + 1) * (resourceChip.height + resourceChip.gap),
  }));
}

/**
 * Where the chips of an operator's results stand, by the top left corner of each: under its card, as tall as it is
 * drawn (`height`), two to a line, the first of a line centered under the right edge of the card as the layout counts
 * it, where a closed card has its outputs, and the second to its left. So a card drawn wider, as one open for editing
 * is, keeps its results in its own column, clear of the card one column on.
 */
export function resultChipPlaces(at: Point, height: number, count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const line = Math.floor(index / resultChip.perLine);
    const beside = index % resultChip.perLine;
    return {
      x: at.x + operatorCard.width - resultChip.width / 2 - beside * (resultChip.width + resultChip.apart),
      y: at.y + height + resultChip.gap + line * (resultChip.height + resultChip.apart),
    };
  });
}

/**
 * How many times further apart the rows of a canvas are drawn than the workflow keeps them: as far as its tallest
 * card needs, with the most chips any of its cards has above it and under it, so that no card lies on the one under
 * it. In eighths, so that a pixel more or less on one card does not move the whole canvas.
 */
export function rowSpread(tallest: number, chips: CardChips = {}): number {
  const needed = (tallest + reachAbove(chips) + reachBelow(chips) + cardGap) / operatorSpacing.row;
  // A height that is not a size, such as that of a card not measured yet, spreads nothing.
  return needed > 1 ? Math.ceil(needed * 8) / 8 : 1;
}

/**
 * Places as they are drawn while the rows are `k` times further apart than they are kept: each `k` times as far from
 * the top of the canvas, where arranging starts, in the same column.
 */
export function spread(places: Record<string, Point>, k: number): Record<string, Point> {
  if (k === 1) return places;
  return Object.fromEntries(Object.entries(places).map(([id, { x, y }]) => [id, { x, y: y * k }]));
}

/** The place kept for one that `spread` draws at `at`. */
const unspread = (at: Point, k: number): Point => ({ x: at.x, y: at.y / k });

/** The card open for editing, as it is drawn: which operator's, and its size. */
export interface OpenCard extends Size {
  id: string;
}

/** Whether a card placed at `place` lies under the open card standing at `at`, in the band of its width. */
const isUnder = (place: Point, at: Point, open: OpenCard) =>
  place.y > at.y && place.x < at.x + open.width && place.x + operatorCard.width > at.x;

/** Where the room of the open card standing at `at` ends: after the card, the chips of its results and the gap. */
const roomEnd = (at: Point, open: OpenCard, chips: Record<string, CardChips>) =>
  at.y + open.height + reachBelow(chips[open.id]) + cardGap;

/**
 * The cards under the open card, in the band of its width, and how much lower they are all drawn: so far that the
 * highest of them, counting the chips above it, starts where the open card's room ends; nothing while it fits.
 */
function lowering(drawn: Record<string, Point>, open: OpenCard, chips: Record<string, CardChips>) {
  const at = drawn[open.id];
  if (!at) return { under: [], by: 0 };
  const under = Object.keys(drawn).filter(id => id !== open.id && isUnder(drawn[id], at, open));
  const highest = Math.min(...under.map(id => drawn[id].y - reachAbove(chips[id])));
  return { under, by: Math.max(0, roomEnd(at, open, chips) - highest) };
}

/**
 * How much lower each card is drawn while one is open for editing, by operator. The cards under the open card, in
 * the band of its width, go down together, so that the highest of them, counting the chips above it, stands the gap
 * under the open card and the chips of its results; the column keeps its order and its spacing. A card not named
 * stays where it is drawn. `drawn` is where the cards are drawn with every card closed, and `chips` what each card has
 * around it, by operator.
 */
export function roomFor(
  drawn: Record<string, Point>,
  open: OpenCard,
  chips: Record<string, CardChips> = {}
): Record<string, number> {
  const { under, by } = lowering(drawn, open, chips);
  return by > 0 ? Object.fromEntries(under.map(id => [id, by])) : {};
}

/**
 * The places to keep for cards dropped at `dropped` on the canvas while the rows are `k` times further apart, by
 * operator: the places they have with the rows as they are kept and every card closed, which a move writes. While a
 * card is open for editing (`open`), the cards under it are drawn lower: a card dropped among them, under the open
 * card in the band of its width, is kept as much higher, and one dropped on the open card or on the room it takes by
 * only the part of that as far down the room as it was dropped, so that it stays under the open card. A card dropped
 * anywhere else is kept where it was dropped. `drawn` is where the cards are drawn with every card closed, as they
 * were before the drop.
 */
export function keptPlaces(
  dropped: Record<string, Point>,
  k: number,
  drawn: Record<string, Point>,
  open?: OpenCard,
  chips: Record<string, CardChips> = {}
): Record<string, Point> {
  // As much lower as the cards under the open card were drawn while these were dragged. The open card is never drawn
  // lower: dragged too, it is where it was dropped, and what was dropped under it is under it there.
  const { by } = open ? lowering(drawn, open, chips) : { by: 0 };
  const at = open && (dropped[open.id] ?? drawn[open.id]);
  return Object.fromEntries(
    Object.entries(dropped).map(([id, place]) => {
      if (!open || !at || id === open.id || !isUnder(place, at, open)) return [id, unspread(place, k)];
      const share = Math.min(1, (place.y - at.y) / (roomEnd(at, open, chips) - at.y));
      return [id, unspread({ x: place.x, y: place.y - by * share }, k)];
    })
  );
}

/**
 * Where places kept as the workflow keeps them are drawn while the rows are `k` times further apart and `open` is open
 * for editing, by id: back where `keptPlaces` takes them from. A place under the open card, in the band of its width,
 * is drawn as much lower as the cards there are; one between the open card's top and the highest of them, as far down
 * the room the open card takes as it lies down that gap. So a place someone else tells of, as where their pointer is,
 * is drawn over what it is over for them. `drawn` is where the cards are drawn with every card closed, and `chips`
 * what each card has around it.
 */
export function drawnPlaces(
  kept: Record<string, Point>,
  k: number,
  drawn: Record<string, Point>,
  open?: OpenCard,
  chips: Record<string, CardChips> = {}
): Record<string, Point> {
  const places = spread(kept, k);
  const at = open && drawn[open.id];
  if (!open || !at) return places;
  const { by } = lowering(drawn, open, chips);
  const end = roomEnd(at, open, chips);
  // Where the cards under the open card would start with it closed, counting the chips above them.
  const highest = end - by;
  return Object.fromEntries(
    Object.entries(places).map(([id, place]) => {
      if (by === 0 || id === open.id || !isUnder(place, at, open)) return [id, place];
      const y = place.y >= highest ? place.y + by : at.y + ((place.y - at.y) * (end - at.y)) / (highest - at.y);
      return [id, { x: place.x, y }];
    })
  );
}
