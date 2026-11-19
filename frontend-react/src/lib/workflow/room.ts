/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Editing a workflow together. Everyone who has a workflow open is in its room on the shared editing service.
// The service keeps the workflow for as long as anyone is in the room: it reads the saved workflow when the first
// person enters, passes each change on to the others, and saves. So nobody's browser loads or saves a workflow,
// and what each person sees is what the room holds.
//
// Each person in a room also tells the others where they are: what they have selected, where their pointer is on
// the canvas, and whose code they have open. Their cursor in that code is told by the code editor itself.

import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import { getSession } from "../session";
import { isAt, lineageOf, type WorkflowDocument } from "./document";
import type { Point } from "./model";
import { type Entry, roomName, roomRefilled, type SaveNotice, sharedEditingPath } from "./shared-editing";

/** Someone else who has the workflow open. */
export interface Collaborator {
  /** Their document's id in the room. */
  clientId: number;
  name: string;
  /** Which of the presence colors they are shown in, for everyone alike: 1 to 6. */
  color: number;
  /** The operators they have selected. */
  selection: string[];
  /** Where their pointer is on the canvas, in the canvas's own coordinates. */
  pointer?: Point;
  /** The operator whose code they have open. */
  code?: string;
}

/** What each person tells the others about themselves. */
interface Presence extends Omit<Collaborator, "clientId" | "name" | "color"> {
  /** Read by the code editor, which shows it beside this person's cursor. */
  user: { name: string; color: string; colorLight: string };
}

/** Whether what the room holds is saved. */
export type SaveState = "saved" | "saving" | "failed";

/** How things stand between this person and the room. */
export interface RoomState {
  /**
   * "entering" until the document holds the room's workflow; "refused" for someone who may not open it;
   * "outdated" once the room was filled anew while this person was away: their document is of an earlier
   * filling, and the way back in is to start again with an empty one.
   */
  entry: "entering" | "entered" | "refused" | "outdated";
  /** The service is out of reach. Changes made meanwhile are kept, and sent once it is in reach again. */
  offline: boolean;
  save: SaveState;
  /** Why the last save failed. */
  saveProblem?: string;
  /** The other people in the room. */
  collaborators: Collaborator[];
}

const presenceColors = 6;
const outside: RoomState = { entry: "entering", offline: false, save: "saved", collaborators: [] };

export class WorkflowRoom {
  private readonly document: WorkflowDocument;
  private readonly workflowId: number;
  private readonly userName: string;
  private readonly listeners = new Set<() => void>();
  /** The connection to the room, while this person is in it. */
  private provider: HocuspocusProvider | undefined;
  private current = outside;

  constructor(document: WorkflowDocument, workflowId: number, userName: string) {
    this.document = document;
    this.workflowId = workflowId;
    this.userName = userName;
  }

  /** Enters the room: from here on the document holds what the room holds. */
  enter(): void {
    const url = new URL(sharedEditingPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // What a connection says after the room is left is not heard.
    const hear = (change: () => Partial<RoomState>) => () => {
      if (this.provider === provider) this.set(change());
    };
    const provider: HocuspocusProvider = new HocuspocusProvider({
      url: url.href,
      name: roomName(this.workflowId),
      document: this.document.doc,
      // The service opens the workflow as this user: that is how it knows what they may do. It is also told
      // which filling of the room the document is of, so that it is not brought together with another.
      token: () =>
        JSON.stringify({ token: getSession()?.token ?? "", lineage: lineageOf(this.document.doc) } satisfies Entry),
      onConnect: hear(() => ({ offline: false })),
      onDisconnect: hear(() => ({ offline: true })),
      onSynced: hear(() => ({ entry: "entered" })),
      onAuthenticationFailed: ({ reason }) =>
        hear(() => ({ entry: reason === roomRefilled ? ("outdated" as const) : ("refused" as const) }))(),
      onAwarenessChange: hear(() => ({ collaborators: this.others() })),
      onStateless: ({ payload }) => {
        const notice = JSON.parse(payload) as SaveNotice;
        hear(() => {
          if (!notice.saved) return { save: "failed" as const, saveProblem: notice.reason };
          // A save that did not reach what was changed since is not the last word: the next one is. What the
          // service had when it saved has all arrived here by now, as it was sent before this notice.
          return isAt(this.document.doc, notice.upTo) ? { save: "saved" as const, saveProblem: undefined } : {};
        })();
      },
    });
    this.provider = provider;
    const color = `var(--presence-${colorOf(this.document.doc.clientID)})`;
    provider.awareness?.setLocalState({
      user: { name: this.userName, color, colorLight: `color-mix(in oklab, ${color} 30%, transparent)` },
      selection: [],
    } satisfies Presence);
    this.document.doc.on("update", this.unsaved);
  }

  /** Leaves the room. */
  leave(): void {
    this.document.doc.off("update", this.unsaved);
    this.provider?.destroy();
    this.provider = undefined;
    this.set(outside);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The same object is returned until something changes. */
  state = (): RoomState => this.current;

  /**
   * Where each person's cursor is in the code they have open: the code editor reads and writes it. Undefined
   * outside the room.
   */
  get awareness(): Awareness | undefined {
    return this.provider?.awareness ?? undefined;
  }

  /** Whether this person has changed something that the room has not been told yet, as while offline. */
  hasUnsent(): boolean {
    return (this.provider?.unsyncedChanges ?? 0) > 0;
  }

  /** Tells the others which operators this person has selected. */
  select(operatorIds: string[]): void {
    this.awareness?.setLocalStateField("selection", operatorIds);
  }

  /** Tells the others where this person's pointer is on the canvas, or that it has left the canvas. */
  point(position: Point | undefined): void {
    this.awareness?.setLocalStateField("pointer", position);
  }

  /** Tells the others which operator's code this person has open, or that they have closed it. */
  openCode(operatorId: string | undefined): void {
    this.awareness?.setLocalStateField("code", operatorId);
  }

  private others(): Collaborator[] {
    const self = this.document.doc.clientID;
    return [...(this.awareness?.getStates() ?? [])]
      .filter(([clientId, presence]) => clientId !== self && "user" in presence)
      .map(([clientId, presence]) => {
        const { user, ...where } = presence as Presence;
        return { clientId, name: user.name, color: colorOf(clientId), ...where };
      })
      .toSorted((a, b) => a.clientId - b.clientId);
  }

  /** Whatever changes once the workflow is here is not saved until the service says so. */
  private readonly unsaved = (): void => {
    if (this.current.entry === "entered") this.set({ save: "saving" });
  };

  private set(change: Partial<RoomState>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }
}

/** The color someone is shown in follows from their id, so that everyone sees them in the same one. */
function colorOf(clientId: number): number {
  return (clientId % presenceColors) + 1;
}
