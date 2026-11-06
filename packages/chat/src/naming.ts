// How a chat gets its name. A chat is named by its start, and by what it is about when it was
// started beside a page. Names are unique per project and kind, so a second chat started in
// the same second takes a number.

/** The name a chat starts with. */
export function chatName(about: string | undefined, started: Date): string {
  const when = started.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${about ? `About ${about}` : "Chat"}, ${when}`;
}

const TRIES = 5;

/** Makes something under a name, numbering the name while the catalog says it is taken. */
export async function createNamed<T>(name: string, create: (name: string) => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await create(n === 1 ? name : `${name} (${n})`);
    } catch (e) {
      if ((e as { status?: number }).status !== 409 || n >= TRIES) throw e;
    }
  }
}
