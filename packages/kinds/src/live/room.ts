// A resource's live session, as the app joins it: who else is on the resource right now and,
// for a workflow, the document they edit at once. One connection per resource, shared by every
// view of it on the page, and left when the last of them goes.
//
// The session is the live service's (a WebSocket behind the gateway at /live/sessions). The
// person's token goes in the protocol's first message; the service asks the catalog who they
// are and what they may do, so a session opens for exactly the people the resource does.

import { Forbidden } from "@hocuspocus/common";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { askAgain, meQuery } from "../queries";
import { accessToken } from "../watch";
import { peopleIn, type Present } from "./presence";

/** A joined session: its document, its awareness, and its connection. */
export type Room = HocuspocusProvider;

const joined = new Map<string, { room: Room; views: number }>();

const sessionsUrl = () => `${window.location.origin.replace(/^http/, "ws")}/live/sessions`;

/** Joins a resource's session, or returns the one another view of it already joined. */
export function joinRoom(rid: string): Room {
  const entry = joined.get(rid);
  if (entry) {
    entry.views++;
    return entry.room;
  }
  const room = new HocuspocusProvider({ url: sessionsUrl(), name: rid, token: async () => (await accessToken()) ?? "" });
  joined.set(rid, { room, views: 1 });
  return room;
}

/** Leaves a session when the last view of its resource is gone. */
export function leaveRoom(rid: string): void {
  const entry = joined.get(rid);
  if (!entry || --entry.views > 0) return;
  joined.delete(rid);
  entry.room.destroy();
}

/**
 * Calls back when a session turns the person away: refused at the door, or let go later
 * because they may no longer read the resource. A connection that only drops says nothing.
 */
export function onTurnedAway(room: Pick<Room, "on" | "off">, turnedAway: () => void): () => void {
  const closed = ({ event }: { event: { reason?: string } }) => {
    if (event.reason === Forbidden.reason) turnedAway();
  };
  room.on("authenticationFailed", turnedAway);
  room.on("close", closed);
  return () => {
    room.off("authenticationFailed", turnedAway);
    room.off("close", closed);
  };
}

/**
 * The session of a resource, for as long as a component shows it. A person the session turns
 * away may no longer read the resource: the app asks the catalog again, and the view shows
 * its answer.
 */
export function useRoom(rid: string | undefined): Room | undefined {
  const queryClient = useQueryClient();
  const [room, setRoom] = useState<Room>();
  useEffect(() => {
    if (!rid) return;
    const joined = joinRoom(rid);
    const stop = onTurnedAway(joined, () => void askAgain(queryClient, rid));
    setRoom(joined);
    return () => {
      stop();
      setRoom(undefined);
      leaveRoom(rid);
    };
  }, [rid, queryClient]);
  return room;
}

/**
 * The people on a resource right now, this person among them. Showing a resource is being on
 * it: the hook joins the session and says who the person is.
 */
export function usePresence(rid: string | undefined): Present[] {
  const room = useRoom(rid);
  const { data: me } = useQuery(meQuery());
  const [people, setPeople] = useState<Present[]>([]);
  const pid = me?.principal.pid;
  const name = me?.principal.displayName;
  useEffect(() => {
    const awareness = room?.awareness;
    if (!awareness || !pid || !name) return;
    awareness.setLocalStateField("user", { pid, name });
    const read = () => setPeople(peopleIn(awareness.getStates() as Map<number, Record<string, unknown>>, awareness.clientID));
    read();
    awareness.on("change", read);
    return () => {
      awareness.off("change", read);
      setPeople([]);
    };
  }, [room, pid, name]);
  return people;
}
