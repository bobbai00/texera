import { Forbidden } from "@hocuspocus/common";
import { describe, expect, it } from "vitest";
import { onTurnedAway } from "./room";

/** A session's events, as the page listens to them. */
function events() {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  return {
    on: (event: string, listener: (payload: never) => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off: (event: string, listener: (payload: never) => void) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload as never);
    },
  };
}

describe("a session that turns the person away", () => {
  it("says so when it refuses them at the door, and when it lets them go later", () => {
    const room = events();
    let times = 0;
    onTurnedAway(room, () => times++);
    room.emit("authenticationFailed", { reason: "permission-denied" });
    expect(times).toBe(1);
    room.emit("close", { event: { code: 1000, reason: Forbidden.reason } });
    expect(times).toBe(2);
  });

  it("says nothing when the connection only drops, and nothing once the page has left", () => {
    const room = events();
    let times = 0;
    const stop = onTurnedAway(room, () => times++);
    room.emit("close", { event: { code: 1006, reason: "" } });
    room.emit("close", { event: { code: 1000, reason: "Server closed the connection" } });
    expect(times).toBe(0);
    stop();
    room.emit("authenticationFailed", { reason: "permission-denied" });
    room.emit("close", { event: { code: 1000, reason: Forbidden.reason } });
    expect(times).toBe(0);
  });
});
