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

import { ws } from "msw";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { admin, reader, type TestUser } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import type { MockPrivilege } from "@/testing/mock-api/access";
import { cutSharedEditing, startSharedEditing } from "@/testing/mock-api/shared-editing";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { operator, piece, workflowContent } from "@/testing/workflow";
import { WorkflowDocument } from "./document";
import { holderOf } from "./holds";
import type { WorkflowContent } from "./model";
import { WorkflowRoom } from "./room";
import { sharedEditingPath } from "./shared-editing";

// What the service does with a room is tested beside the service (shared-editing-service/server.test.ts); here
// is what a person in a room knows about it and about the others.

/**
 * Someone who opens a workflow: their document, and their place in its room, which they leave when the test ends.
 * What they do before they are in the room, such as saying what they edit, is `beforeEntering`.
 */
async function open(user: TestUser, workflowId: number, beforeEntering?: (room: WorkflowRoom) => void) {
  signInAs(user);
  const document = new WorkflowDocument();
  const room = new WorkflowRoom(document, workflowId, user.name);
  onTestFinished(() => room.leave());
  beforeEntering?.(room);
  room.enter();
  await vi.waitFor(() => expect(room.state().entry).toBe("entered"));
  return { document, room };
}

/** A workflow of the admin's that the reader may change, or only look at. */
function sharedWorkflow(privilege: MockPrivilege = "WRITE") {
  return addWorkflow(db, {
    name: "Iris",
    content: workflowContent([operator("PythonUDFV2", "udf")]),
    grants: [{ uid: reader.uid, privilege }],
  });
}

/** Everyone in the room as someone there sees them, themselves included. */
const everyone = (room: WorkflowRoom) => [room.state().me!, ...room.state().collaborators];

/** The service's socket, as the test sees it beside the service. */
const sharedEditing = ws.link(`ws://${window.location.host}${sharedEditingPath}`);

/** Drops the sockets to the service that open from now on, and no others, as one person's network does. */
function connectionsFromNow(): { drop: () => void } {
  const sockets: { close: () => void }[] = [];
  server.use(sharedEditing.addEventListener("connection", ({ client }) => void sockets.push(client)));
  return { drop: () => sockets.splice(0).forEach(client => client.close()) };
}

describe("WorkflowRoom", () => {
  it("is outside the room until it is entered, and again once it is left", async () => {
    const { wid } = sharedWorkflow();
    signInAs(admin);
    const document = new WorkflowDocument();
    const room = new WorkflowRoom(document, wid, admin.name);
    expect(room.state()).toEqual({ entry: "entering", offline: false, save: "saved", collaborators: [] });
    expect(room.awareness).toBeUndefined();

    room.enter();
    await vi.waitFor(() => expect(room.state().entry).toBe("entered"));
    expect(room.awareness).toBeDefined();
    expect(room.state().me).toMatchObject({ clientId: document.doc.clientID, name: admin.name, selection: [] });

    room.leave();
    expect(room.state().entry).toBe("entering");
    expect(room.state().me).toBeUndefined();
    expect(room.awareness).toBeUndefined();
  });

  it("tells each person who else is there and where they are, until they leave", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    await vi.waitFor(() => expect(ada.room.state().collaborators).toHaveLength(1));
    const [seen] = ada.room.state().collaborators;
    expect(seen).toMatchObject({ name: reader.name, selection: [] });
    expect(seen.color).toBeGreaterThanOrEqual(1);
    expect(seen.color).toBeLessThanOrEqual(6);

    grace.room.select(["udf"]);
    grace.room.point({ x: 120, y: 40 });
    grace.room.openCode("udf");
    await vi.waitFor(() =>
      expect(ada.room.state().collaborators).toMatchObject([
        { name: reader.name, selection: ["udf"], pointer: { x: 120, y: 40 }, code: "udf" },
      ])
    );
    // Each sees the other, and nobody sees themselves.
    expect(grace.room.state().collaborators).toMatchObject([{ name: admin.name }]);

    grace.room.point(undefined);
    grace.room.openCode(undefined);
    await vi.waitFor(() => expect(ada.room.state().collaborators[0]).not.toHaveProperty("code", "udf"));
    expect(ada.room.state().collaborators[0].pointer).toBeUndefined();

    grace.room.leave();
    await vi.waitFor(() => expect(ada.room.state().collaborators).toEqual([]));
  });

  it("tells the others which operator's settings a person is editing, and since when, until they stop or leave", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);

    const began = Date.now();
    grace.room.edit("udf");
    await vi.waitFor(() =>
      expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, editing: { operatorId: "udf" } }])
    );
    const since = ada.room.state().collaborators[0].editing?.since;
    expect(since).toBeGreaterThanOrEqual(began);
    expect(since).toBeLessThanOrEqual(Date.now());
    // Each sees themselves as the others see them.
    expect(grace.room.state().me?.editing).toEqual({ operatorId: "udf", since });

    grace.room.edit(undefined);
    await vi.waitFor(() => expect(ada.room.state().collaborators[0].editing).toBeUndefined());
    expect(grace.room.state().me?.editing).toBeUndefined();

    grace.room.edit("udf");
    await vi.waitFor(() => expect(ada.room.state().collaborators[0].editing).toMatchObject({ operatorId: "udf" }));
    grace.room.leave();
    await vi.waitFor(() => expect(ada.room.state().collaborators).toEqual([]));
  });

  it("keeps the moment a person began editing an operator while they go on editing it, and only then", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    const sinceNow = () => grace.room.state().me?.editing?.since ?? Number.NaN;
    const later = (moment: number) => vi.waitFor(() => expect(Date.now()).toBeGreaterThan(moment));

    grace.room.edit("udf");
    const first = sinceNow();
    await later(first);
    grace.room.edit("udf");
    expect(grace.room.state().me?.editing).toEqual({ operatorId: "udf", since: first });

    // Another operator is begun anew.
    grace.document.add(piece([operator("Limit", "limit")]));
    grace.room.edit("limit");
    const second = sinceNow();
    expect(second).toBeGreaterThan(first);
    await vi.waitFor(() =>
      expect(ada.room.state().collaborators[0]?.editing).toEqual({ operatorId: "limit", since: second })
    );

    // So is the same operator after they stopped editing it.
    grace.room.edit(undefined);
    await later(second);
    grace.room.edit("limit");
    expect(sinceNow()).toBeGreaterThan(second);
  });

  it("tells nobody that someone who may only look is editing, whether they say so before or after they are in", async () => {
    const { wid } = sharedWorkflow("READ");
    const ada = await open(admin, wid);
    const grace = await open(reader, wid, room => room.edit("udf"));

    grace.room.select(["udf"]);
    await vi.waitFor(() =>
      expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, selection: ["udf"] }])
    );
    expect(ada.room.state().collaborators[0].editing).toBeUndefined();

    grace.room.edit(undefined);
    grace.room.edit("udf");
    grace.room.point({ x: 120, y: 40 });
    await vi.waitFor(() => expect(ada.room.state().collaborators[0].pointer).toEqual({ x: 120, y: 40 }));
    expect(ada.room.state().collaborators[0].editing).toBeUndefined();
    expect(grace.room.state().me?.editing).toBeUndefined();
  });

  it("tells what a person edits once they are in the room, though they said so before they entered it", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    // As when the editor starts again in a new room: it says what is open before the room is entered.
    const began = Date.now();
    const grace = await open(reader, wid, room => room.edit("udf"));

    await vi.waitFor(() =>
      expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, editing: { operatorId: "udf" } }])
    );
    expect(ada.room.state().collaborators[0].editing?.since).toBeGreaterThanOrEqual(began);
    expect(grace.room.state().me?.editing).toEqual(ada.room.state().collaborators[0].editing);
  });

  it("is seen at once, with what they edit, when they enter the room they left again", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    grace.room.edit("udf");
    await vi.waitFor(() => expect(ada.room.state().collaborators).toMatchObject([{ editing: { operatorId: "udf" } }]));

    // As when the editor enters its room again, with the card still open.
    grace.room.leave();
    await vi.waitFor(() => expect(ada.room.state().collaborators).toEqual([]));
    grace.room.enter();
    await vi.waitFor(() => expect(grace.room.state().entry).toBe("entered"));
    await vi.waitFor(() =>
      expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, editing: { operatorId: "udf" } }])
    );
  });

  it("tells again what a person edits once their connection is back, as begun then", async () => {
    startSharedEditing({ roomStaysMs: 60_000 });
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    grace.room.edit("udf");
    await vi.waitFor(() => expect(ada.room.state().collaborators).toMatchObject([{ editing: { operatorId: "udf" } }]));

    cutSharedEditing();
    await vi.waitFor(() => expect(grace.room.state().offline).toBe(true));
    const away = Date.now();
    // A connection that comes back says where this person is before the service says what they may do there, so
    // what they edit is left out of it until then.
    expect(grace.room.state().me?.editing).toBeUndefined();

    await vi.waitFor(
      () =>
        expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, editing: { operatorId: "udf" } }]),
      { timeout: 10_000 }
    );
    expect(ada.room.state().collaborators[0].editing?.since).toBeGreaterThanOrEqual(away);
    expect(grace.room.state().me?.editing).toEqual(ada.room.state().collaborators[0].editing);
  }, 20_000);

  it("leaves an operator to whoever opened it while the person editing it was away", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const graces = connectionsFromNow();
    const grace = await open(reader, wid);
    grace.room.edit("udf");
    await vi.waitFor(() => expect(ada.room.state().collaborators).toMatchObject([{ editing: { operatorId: "udf" } }]));

    // Only Grace's connection drops: the room sees her go, so the operator is free, and Ada opens it.
    graces.drop();
    await vi.waitFor(() => expect(ada.room.state().collaborators).toEqual([]));
    ada.room.edit("udf");

    // Back, Grace tells again what she edits, as begun then: Ada began first, and holds it as both of them see it.
    await vi.waitFor(
      () =>
        expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, editing: { operatorId: "udf" } }]),
      { timeout: 10_000 }
    );
    expect(holderOf("udf", everyone(ada.room))).toMatchObject({ name: admin.name });
    await vi.waitFor(() => expect(holderOf("udf", everyone(grace.room))).toMatchObject({ name: admin.name }));
  }, 20_000);

  it("knows who is still there, and what they edit, as soon as its own dropped connection is back", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const graces = connectionsFromNow();
    const grace = await open(reader, wid);
    ada.room.edit("udf");
    await vi.waitFor(() =>
      expect(grace.room.state().collaborators).toMatchObject([{ name: admin.name, editing: { operatorId: "udf" } }])
    );

    graces.drop();
    await vi.waitFor(() => expect(grace.room.state().offline).toBe(true));
    expect(grace.room.state().collaborators).toEqual([]);

    // Ada tells nothing new meanwhile: what the room tells Grace once she is back is what Ada told before.
    await vi.waitFor(() => expect(grace.room.state().offline).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() =>
      expect(grace.room.state().collaborators).toMatchObject([{ name: admin.name, editing: { operatorId: "udf" } }])
    );
  }, 20_000);

  it("tells nobody what a person edits once they may only look, though they were editing when their connection dropped", async () => {
    startSharedEditing({ roomStaysMs: 60_000 });
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    grace.room.edit("udf");
    await vi.waitFor(() => expect(ada.room.state().collaborators).toMatchObject([{ editing: { operatorId: "udf" } }]));

    cutSharedEditing();
    await vi.waitFor(() => expect(grace.room.state().offline).toBe(true));
    // Meanwhile the owner lets them only look: the service says so as it lets them back in.
    db.resources.find(resource => resource.type === "workflow" && resource.id === wid)!.grants = [
      { uid: reader.uid, privilege: "READ" },
    ];
    await vi.waitFor(() => expect(grace.room.state().offline).toBe(false), { timeout: 10_000 });

    grace.room.select(["udf"]);
    await vi.waitFor(
      () => expect(ada.room.state().collaborators).toMatchObject([{ name: reader.name, selection: ["udf"] }]),
      { timeout: 10_000 }
    );
    expect(ada.room.state().collaborators[0].editing).toBeUndefined();
    expect(grace.room.state().me?.editing).toBeUndefined();
  }, 20_000);

  it("gives its listeners the same state until something changes, and stops when they stop listening", async () => {
    const { wid } = sharedWorkflow();
    const ada = await open(admin, wid);
    const listener = vi.fn();
    const stop = ada.room.subscribe(listener);
    const before = ada.room.state();
    expect(ada.room.state()).toBe(before);

    ada.document.patchOperator("udf", { customDisplayName: "Score" });
    expect(listener).toHaveBeenCalled();
    expect(ada.room.state()).not.toBe(before);
    expect(ada.room.state().save).toBe("saving");

    stop();
    listener.mockClear();
    await vi.waitFor(() => expect(ada.room.state().save).toBe("saved"));
    expect(listener).not.toHaveBeenCalled();
  });

  // Coming back takes the time the connection waits before it tries again: a second, and more on a busy machine.
  it("sends what was changed while offline once the room is in reach again, if the room is still the same", async () => {
    startSharedEditing({ roomStaysMs: 60_000 });
    const workflow = sharedWorkflow();
    const ada = await open(admin, workflow.wid);

    cutSharedEditing();
    await vi.waitFor(() => expect(ada.room.state().offline).toBe(true));
    ada.document.patchOperator("udf", { customDisplayName: "Typed while offline" });
    expect(ada.room.hasUnsent()).toBe(true);

    await vi.waitFor(() => expect(ada.room.state().offline).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() =>
      expect((JSON.parse(workflow.content) as WorkflowContent).operators[0].customDisplayName).toBe(
        "Typed while offline"
      )
    );
    expect(ada.room.state().entry).toBe("entered");
  }, 20_000);

  it("is outdated once the room was filled anew while it was away, and takes nothing from the new filling", async () => {
    const workflow = sharedWorkflow();
    const ada = await open(admin, workflow.wid);

    // The room closes behind its last person; the next one to come fills it again from the saved workflow.
    cutSharedEditing();
    await vi.waitFor(() => expect(ada.room.state().offline).toBe(true));
    ada.document.patchOperator("udf", { customDisplayName: "Typed while offline" });

    await vi.waitFor(() => expect(ada.room.state().entry).toBe("outdated"), { timeout: 10_000 });
    expect(ada.room.hasUnsent()).toBe(true);
    expect((JSON.parse(workflow.content) as WorkflowContent).operators[0].customDisplayName).toBe("Python UDF");

    // Starting again with an empty document is the way back in.
    const again = await open(admin, workflow.wid);
    expect(again.document.content().operators[0].customDisplayName).toBe("Python UDF");
  }, 20_000);
});
