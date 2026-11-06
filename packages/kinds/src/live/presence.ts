// Who is on a resource right now. Everyone in a resource's live session says who they are,
// and anything else a page shares about them (a cursor on a canvas, that they are typing),
// through the session's awareness: state that is never saved and goes when they leave.

/** Who someone in a session is. */
export interface Person {
  pid: string;
  name: string;
}

/** Someone in a session, as the pages show them. */
export interface Present extends Person {
  /** Whether this is the person looking at the page. */
  self: boolean;
  /** The connection their state comes from. */
  clientId: number;
  /** Everything they share in the session. */
  state: Record<string, unknown>;
}

const isPerson = (v: unknown): v is Person =>
  typeof v === "object" && v !== null && typeof (v as Person).pid === "string" && typeof (v as Person).name === "string";

/**
 * The people in a session, from its awareness states: each person once however many tabs
 * they have open, the person themself first, the others by name.
 */
export function peopleIn(states: Map<number, Record<string, unknown>>, self: number): Present[] {
  const byPid = new Map<string, Present>();
  for (const [clientId, state] of states) {
    if (!isPerson(state.user)) continue;
    const known = byPid.get(state.user.pid);
    // One of several tabs: this tab stands for the person on their own screen.
    if (known && known.clientId === self) continue;
    if (known && clientId !== self) continue;
    byPid.set(state.user.pid, { pid: state.user.pid, name: state.user.name, self: clientId === self, clientId, state });
  }
  return [...byPid.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}

/** How many colours people in a session are told apart by. */
export const PRESENCE_TONES = 6;

/** A person's colour in every session, as an index into the presence tones: their icon's ring, their cursor. */
export function presenceTone(pid: string): number {
  let hash = 0;
  for (let i = 0; i < pid.length; i++) hash = (hash * 31 + pid.charCodeAt(i)) >>> 0;
  return hash % PRESENCE_TONES;
}
