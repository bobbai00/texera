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

// The shared editing service, as it runs: a socket the app opens to /shared-editing reaches the service's own
// code (shared-editing-service/server.ts) in this process, and the service reaches the fake backend the way the
// app does. So a test edits a workflow with others through the real service, without a server to start.

import { ws } from "msw";
import { sharedEditingPath } from "@/lib/workflow/shared-editing";
import { texeraBackend } from "../../../shared-editing-service/backend";
import { createSharedEditingServer, type SharedEditingOptions } from "../../../shared-editing-service/server";

/** How long after a change the service saves, in a test. */
export const saveDelayMs = 30;

// In a test a room is closed as soon as the last person leaves, unless the test says otherwise.
const defaults: SharedEditingOptions = { saveDelayMs, roomStaysMs: 0 };
let service = createSharedEditingServer(texeraBackend(window.location.origin), defaults);

/** Starts the service with other settings, for the test that is running: such as rooms that stay a while. */
export function startSharedEditing(options: SharedEditingOptions): void {
  service = createSharedEditingServer(texeraBackend(window.location.origin), { ...defaults, ...options });
}

/** The rooms the service holds, by their names. */
export function openRooms(): string[] {
  return [...service.server.hocuspocus.documents.keys()];
}

/** The sockets that are open, each with the way to cut it from the service's side. */
const cuts = new Set<() => void>();

/** Cuts every connection, as a network that drops does. Whoever is still there comes back by themselves. */
export function cutSharedEditing(): void {
  for (const cut of [...cuts]) cut();
}

/**
 * Stops the service and starts it again: every connection is cut, and every room is saved and closed. Whoever is
 * still there comes back into a room filled anew from the backend. testing/setup.ts calls it after each test, so
 * that no test's saving reaches into the next.
 */
export async function restartSharedEditing(): Promise<void> {
  const { hocuspocus } = service.server;
  cutSharedEditing();
  await service.closeEmptyRooms();
  const busy = () => hocuspocus.documents.size + hocuspocus.loadingDocuments.size + hocuspocus.unloadingDocuments.size;
  while (busy() > 0) await new Promise(resolve => setTimeout(resolve, 5));
  startSharedEditing({});
}

/** The fake backend has no language server: whoever asks for one finds none, as on a deployment without one. */
export function languageServerHandlers() {
  const server = ws.link(`ws://${window.location.host}/python-language-server`);
  return [server.addEventListener("connection", ({ client }) => client.close())];
}

export function sharedEditingHandlers() {
  const link = ws.link(`ws://${window.location.host}${sharedEditingPath}`);
  return [
    link.addEventListener("connection", ({ client }) => {
      let open = true;
      // What the service needs of a socket: to send, to close, and to know whether it is open.
      const socket = {
        send: (data: Uint8Array<ArrayBuffer>) => client.send(data),
        close: (code?: number, reason?: string) => client.close(code, reason),
        get readyState() {
          return open ? WebSocket.OPEN : WebSocket.CLOSED;
        },
      };
      const connection = service.server.hocuspocus.handleConnection(
        socket,
        new Request(window.location.origin + sharedEditingPath)
      );
      const closed = (code: number, reason: string) => {
        if (!open) return;
        open = false;
        cuts.delete(cut);
        connection.handleClose({ code, reason });
      };
      const cut = () => {
        closed(1001, "The service is going down.");
        client.close(1001);
      };
      cuts.add(cut);
      client.addEventListener("message", ({ data }) => connection.handleMessage(new Uint8Array(data as ArrayBuffer)));
      client.addEventListener("close", ({ code, reason }) => closed(code, reason));
    }),
  ];
}
