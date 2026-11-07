// How a chat gets its name. A chat is named by its start, and by what it is about when it was
// started beside a page. A name is a label: two chats started in the same second share it.

/** The name a chat starts with. */
export function chatName(about: string | undefined, started: Date): string {
  const when = started.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${about ? `About ${about}` : "Chat"}, ${when}`;
}
