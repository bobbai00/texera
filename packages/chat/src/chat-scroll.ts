/** Where a chat's scroller stands at one moment. */
export interface ScrollPoint {
  top: number;
  height: number;
  client: number;
}

/** Within this many pixels of its end, a chat is at its end. */
const AT_THE_END = 80;

/**
 * Whether a chat keeps following its end after a scroll event. Only the reader moving up takes it
 * away from there. The event of the chat's own move to its end can arrive after the messages have
 * grown, far from the end again, and a chat whose content shrank is moved up by the browser;
 * neither is someone who stopped reading the end.
 */
export function staysPinned(pinned: boolean, before: ScrollPoint, now: ScrollPoint): boolean {
  if (now.height - now.top - now.client < AT_THE_END) return true;
  return pinned && !(now.top < before.top && now.height >= before.height);
}
