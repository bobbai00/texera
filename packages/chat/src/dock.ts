// Which chat a page's dock continues. A chat is bound to no resource; the app only remembers,
// in the person's preferences, the chat they last used beside each page, so opening the dock
// there again shows it. Starting over forgets it.

type Preferences = Record<string, unknown>;

const KEPT = 50;

const entries = (preferences: Preferences | undefined): Record<string, unknown> => {
  const dock = preferences?.dock;
  return typeof dock === "object" && dock !== null && !Array.isArray(dock) ? (dock as Record<string, unknown>) : {};
};

/** The chat last used beside a resource's page, by the resource's rid. */
export function dockChat(preferences: Preferences | undefined, rid: string): string | undefined {
  const chat = entries(preferences)[rid];
  return typeof chat === "string" && chat ? chat : undefined;
}

/**
 * The preferences with the chat of one page set, or forgotten when there is none. The pages
 * used most recently are kept.
 */
export function withDockChat(preferences: Preferences, rid: string, conversation: string | undefined): Preferences {
  const { [rid]: _, ...others } = entries(preferences);
  const recent = Object.entries(conversation ? { ...others, [rid]: conversation } : others).slice(-KEPT);
  return { ...preferences, dock: Object.fromEntries(recent) };
}
