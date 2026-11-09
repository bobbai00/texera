// What people have hold of in a live session. A person holds at most one thing there: the operator
// they have selected or open on a canvas, the box they have gone into on a chat's graph. The others
// see who has it and can look at it, not change it. A hold is said through the session's awareness
// beside who is there, so it is never saved and goes when they do. It coordinates people who are
// allowed to change the thing; who is allowed stays the catalog's to say.

import { isPerson, type Person } from "./presence";

/** What a person does with what they hold. */
export type Doing = "viewing" | "editing";

/** What a person would hold, if nobody has it. */
export interface Wanted {
  id: string;
  doing: Doing;
}

/** What a person says they hold, and since when by their clock. */
export interface Claim extends Wanted {
  since: number;
}

/** Who holds a thing. */
export interface Hold extends Person {
  doing: Doing;
}

/** The field of the awareness state a claim is said in. */
export const CLAIM = "hold";

/** How long a person may be away before what they hold is free again. */
export const AWAY_AFTER_MS = 2 * 60_000;

export const claimOf = (state: Record<string, unknown> | null | undefined): Claim | undefined => {
  const claim = state?.[CLAIM] as Claim | null | undefined;
  return claim && typeof claim.id === "string" && typeof claim.since === "number" && (claim.doing === "viewing" || claim.doing === "editing")
    ? claim
    : undefined;
};

/**
 * Who holds each thing, from the session's awareness states: of those who claim it, whoever did
 * so first, and of two at the same moment the lower connection. Everyone who sees the same states
 * gets the same answer, so two people reaching for one thing at once end up agreeing.
 */
export function holdsIn(states: Map<number, Record<string, unknown>>): Map<string, Hold> {
  const first = new Map<string, { claim: Claim; clientId: number; person: Person }>();
  for (const [clientId, state] of states) {
    const claim = claimOf(state);
    if (!claim || !isPerson(state.user)) continue;
    const known = first.get(claim.id);
    if (!known || claim.since < known.claim.since || (claim.since === known.claim.since && clientId < known.clientId))
      first.set(claim.id, { claim, clientId, person: state.user });
  }
  return new Map(
    [...first].map(([id, { claim, person }]) => [id, { pid: person.pid, name: person.name, doing: claim.doing }])
  );
}

/** What a person should now claim: what they want, unless someone else has it; held from when they first did. */
export function claimFor(
  wanted: Wanted | null,
  holds: ReadonlyMap<string, Hold>,
  pid: string,
  current: Claim | undefined,
  now: number
): Claim | null {
  if (!wanted) return null;
  const holder = holds.get(wanted.id);
  if (holder && holder.pid !== pid) return null;
  return { ...wanted, since: current?.id === wanted.id ? current.since : now };
}

/** The holds of everyone but a person, by what is held. */
export const holdsOfOthers = (holds: ReadonlyMap<string, Hold>, pid: string): Map<string, Hold> =>
  new Map([...holds].filter(([, hold]) => hold.pid !== pid));

/** Whether two sets of holds say the same. */
export function sameHolds(a: ReadonlyMap<string, Hold>, b: ReadonlyMap<string, Hold>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, hold] of a) {
    const other = b.get(id);
    if (!other || other.pid !== hold.pid || other.doing !== hold.doing) return false;
  }
  return true;
}
