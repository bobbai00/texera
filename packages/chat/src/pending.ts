// The first message of a chat, handed from the page that starts the chat to the page that is
// the chat. A chat is created when its first message is sent; the message, with its files, is
// kept here for the moment between the two pages and taken once.

export interface FirstMessage {
  text: string;
  files: File[];
}

const pending = new Map<string, FirstMessage>();

export function leaveFirstMessage(rid: string, message: FirstMessage): void {
  pending.set(rid, message);
}

/** Whether a chat is about to be asked the message it was made for. */
export const awaitsFirstMessage = (rid: string): boolean => pending.has(rid);

export function takeFirstMessage(rid: string): FirstMessage | undefined {
  const message = pending.get(rid);
  pending.delete(rid);
  return message;
}
