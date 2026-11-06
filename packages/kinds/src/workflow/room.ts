// A card open for editing is taller and wider than the cards around it. The canvas makes room
// for it: what lies under it, in the band of its width, is drawn lower by as much as the open
// card reaches past it, and goes back when the card closes. Nothing moves in the workflow.

import { CARD, type Positions } from "@texera/workflow-model";

/** The least room between the open card and the card under it. */
const GAP = 32;

/** The card open for editing, as it is drawn: which operator, and its size. */
export interface OpenCard {
  id: string;
  width: number;
  height: number;
}

/** How much lower each card is drawn while `open` is, by operator; a card not named stays. */
export function roomFor(drawn: Positions, open: OpenCard): Record<string, number> {
  const at = drawn[open.id];
  if (!at) return {};
  const under = Object.entries(drawn).filter(
    ([id, p]) => id !== open.id && p.y > at.y && p.x < at.x + open.width && p.x + CARD.width > at.x
  );
  if (under.length === 0) return {};
  const nearest = Math.min(...under.map(([, p]) => p.y));
  const lower = at.y + open.height + GAP - nearest;
  return lower > 0 ? Object.fromEntries(under.map(([id]) => [id, lower])) : {};
}
