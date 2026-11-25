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

// The shared editing service: the rooms in which people edit workflows together. A room holds one workflow as a
// Yjs document for as long as anyone is in it. The service
//   - lets a person into a room only if the backend lets them open the workflow, and lets them change it only if
//     the backend lets them edit it;
//   - fills the room from the saved workflow when the first person enters, and turns away a document that came
//     from an earlier filling: its holder starts again from the room;
//   - keeps a room for a while after the last person has left, so that someone whose connection dropped comes
//     back to the room they left, with what they changed meanwhile;
//   - passes each change, and where each person is, on to the others in the room;
//   - saves the workflow a moment after it last changed, and when the last person leaves, in the name of the
//     person who changed it last, and tells the room how that went;
//   - lets go of a room only once what it holds is saved, or can never be, as when the workflow was deleted.
// Keeping documents in step and passing presence on is Hocuspocus's work; what is Texera's own is in the hooks.

import { type DirectConnection, type Document, type Hocuspocus, Server } from "@hocuspocus/server";
import { lineageOf, progressOf, readContent, writeContent } from "@/lib/workflow/document";
import { type Entry, roomRefilled, type SaveNotice, workflowIdOf } from "@/lib/workflow/shared-editing";
import { type Backend, BackendError } from "./backend";

/** What the service remembers of a person in a room: the token it works for them with. */
interface Member {
  token: string;
}

export interface SharedEditingOptions {
  /** How long after the last change a workflow is saved. */
  saveDelayMs?: number;
  /** The longest a workflow that keeps changing goes without being saved. */
  longestUnsavedMs?: number;
  /** How long a room is kept after the last person has left it. */
  roomStaysMs?: number;
}

export interface SharedEditingService {
  server: Server<Member>;
  /** Closes the rooms that are kept though nobody is in them, as when the service stops. */
  closeEmptyRooms(): Promise<void>;
}

export function createSharedEditingServer(
  backend: Backend,
  { saveDelayMs = 1500, longestUnsavedMs = 10_000, roomStaysMs = 5 * 60_000 }: SharedEditingOptions = {}
): SharedEditingService {
  const workflowOf = (room: string): number => {
    const workflowId = workflowIdOf(room);
    if (workflowId === undefined) throw new Error(`"${room}" is not a workflow's room.`);
    return workflowId;
  };
  /** What keeps each room that is kept: a connection of the service's own, and the timer that lets go of it. */
  const kept = new Map<string, { hold: Promise<DirectConnection>; timer?: NodeJS.Timeout }>();
  /** Keeps a room open, whoever is in it, until it is let go. */
  const keep = (instance: Hocuspocus, room: string, context: Member) => {
    const keeping = kept.get(room);
    if (keeping) clearTimeout(keeping.timer);
    else kept.set(room, { hold: instance.openDirectConnection(room, context) });
  };
  /** Lets go of a room once it has stayed its while, unless someone is in it by then. */
  const letGoLater = (document: Document) => {
    const keeping = kept.get(document.name);
    if (!keeping) return;
    clearTimeout(keeping.timer);
    keeping.timer = setTimeout(() => {
      // Someone who came back since keeps the room; the next one to leave starts the wait again.
      if (document.connections.size === 0) void letGo(document.name);
    }, roomStaysMs);
    keeping.timer.unref();
  };
  // Letting go saves the room first; a room whose save fails is kept again (onStoreDocument).
  const letGo = async (room: string) => {
    const keeping = kept.get(room);
    kept.delete(room);
    clearTimeout(keeping?.timer);
    await (await keeping?.hold)?.disconnect();
  };

  const server = new Server<Member>({
    quiet: true,
    debounce: saveDelayMs,
    maxDebounce: longestUnsavedMs,

    async onAuthenticate({ token: presented, documentName, connectionConfig, instance }): Promise<Member> {
      const { token, lineage } = JSON.parse(presented) as Entry;
      // Opening the workflow as this person is the check: the backend refuses someone who may not see it.
      const { readonly } = await backend.open(workflowOf(documentName), token);
      const room = instance.documents.get(documentName);
      if (lineage !== undefined && lineage !== (room && lineageOf(room))) {
        throw Object.assign(new Error("The room was filled anew."), { reason: roomRefilled });
      }
      connectionConfig.readOnly = readonly;
      return { token };
    },

    async onLoadDocument({ document, documentName, context }) {
      const { content } = await backend.open(workflowOf(documentName), context.token);
      writeContent(document, content);
    },

    connected({ documentName, instance, context }) {
      if (roomStaysMs > 0) keep(instance, documentName, context);
      return Promise.resolve();
    },

    onDisconnect({ document }) {
      letGoLater(document);
      return Promise.resolve();
    },

    async onStoreDocument({ document, documentName, lastContext, instance }) {
      const tell = (notice: SaveNotice) => document.broadcastStateless(JSON.stringify(notice));
      // What is saved is the room as it is now; whatever changes while the backend saves it is for the next save.
      const upTo = progressOf(document);
      try {
        await backend.save(workflowOf(documentName), readContent(document), lastContext.token);
        tell({ saved: true, upTo });
      } catch (error) {
        tell({ saved: false, reason: error instanceof Error ? error.message : String(error) });
        // What could not be saved is kept, and saved again each time it has stayed its while, unless the backend
        // refused it for good: a deleted workflow, or one that the person who changed it may no longer change.
        if (roomStaysMs > 0 && !(error instanceof BackendError && error.final)) {
          keep(instance, documentName, lastContext);
          if (document.connections.size === 0) letGoLater(document);
        }
        throw error;
      }
    },
  });

  return {
    server,
    closeEmptyRooms: async () => {
      await Promise.all([...kept.keys()].map(letGo));
    },
  };
}
