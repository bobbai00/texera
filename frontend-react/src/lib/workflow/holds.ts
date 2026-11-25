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

// Holds: one person at a time edits an operator's settings. Whoever opens an operator's card to change it tells the
// others which operator it is and the moment they opened it, by their own clock (WorkflowRoom.edit()): that is
// their claim, and the claim that wins is the hold. Of those who open one card, whoever began first holds it until
// they close it or are no longer in the room; meanwhile the others see who holds it, and do not open it. A claim
// told again after its connection was away begins anew, so whoever opened the card meanwhile keeps it. Everyone
// works out who holds what from the claims everyone told the room, by the rules here, so all come to the same
// answer, even when two people open one card at the same moment. A card opened only to look, as at a version or on
// a workflow its viewer may only look at, claims nothing, and the room tells no claim while the service lets a
// person only look. A person here is a place in the room, not an account: two tabs of one person are two people.
//
// Holds are coordination in the UI only. The shared editing service passes them on without looking at them, and
// takes a change to a held operator like any other. Undo and redo are not guarded either, nor is restoring a version,
// which is a change of the whole workflow: undoing an earlier change of one's own, or restoring how the workflow was,
// can change an operator that someone else holds now.

import type { Claim, Collaborator } from "./room";

/** Someone in a workflow's room, as far as holds go: their id there, and their claim, if they have one. */
export type Claimant = Pick<Collaborator, "clientId" | "editing">;

/**
 * Who holds an operator, among everyone in the room, this person included: of those who claim it, whoever began
 * first, and of two who began at the same moment, the one with the lower id. The moments are each person's own
 * clock, so of two whose clocks disagree the one who began later may hold it, but everyone agrees on who does.
 */
export function holderOf<P extends Claimant>(operatorId: string, everyone: readonly P[]): P | undefined {
  return everyone
    .flatMap(person => {
      const claim = claimOf(person);
      return claim?.operatorId === operatorId ? [{ person, since: claim.since }] : [];
    })
    .toSorted((a, b) => a.since - b.since || a.person.clientId - b.person.clientId)
    .at(0)?.person;
}

/**
 * The operators that someone other than this person holds, each with whoever holds it: this person may open any
 * operator that is not in it. `me` is undefined for someone outside the room.
 */
export function heldByOthers<P extends Claimant>(me: P | undefined, others: readonly P[]): Map<string, P> {
  const everyone = me ? [me, ...others] : others;
  const held = new Map<string, P>();
  for (const person of others) {
    const claim = claimOf(person);
    const holder = claim && holderOf(claim.operatorId, everyone);
    if (claim && holder && holder !== me) held.set(claim.operatorId, holder);
  }
  return held;
}

/**
 * Someone's claim, when it names an operator and a moment: the room passes on what each browser says, and a browser
 * of another version may say it otherwise.
 */
function claimOf({ editing }: Claimant): Claim | undefined {
  return typeof editing?.operatorId === "string" && Number.isFinite(editing.since) ? editing : undefined;
}
