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

// What the app and the shared editing service agree on, beyond the layout of the document (document.ts).

/** Where the service is reached, on the app's own host. */
export const sharedEditingPath = "/shared-editing";

/** The name of a workflow's room on the service. */
export function roomName(workflowId: number): string {
  return String(workflowId);
}

/** The workflow a room is for. Undefined for a name that is not a room's. */
export function workflowIdOf(name: string): number | undefined {
  return /^\d+$/.test(name) ? Number(name) : undefined;
}

/**
 * What the service tells everyone in a room each time it has tried to save the workflow. A save that went well
 * says how far it reached (progressOf() in document.ts): a change made while it was under way is not in it.
 */
export type SaveNotice = { saved: true; upTo: string } | { saved: false; reason: string };

/** What a person presents to enter a room. */
export interface Entry {
  /** The token of their session: the service opens the workflow with it, as them. */
  token: string;
  /** Which filling of the room their document came from, when it has been in the room before (document.ts). */
  lineage?: string;
}

/** Why the service turns away a document that came from an earlier filling of the room. */
export const roomRefilled = "room-refilled";
