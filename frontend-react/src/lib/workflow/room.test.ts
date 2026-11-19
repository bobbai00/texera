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

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { admin, reader, type TestUser } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { cutSharedEditing, startSharedEditing } from "@/testing/mock-api/shared-editing";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { signInAs } from "@/testing/session";
import { operator, workflowContent } from "@/testing/workflow";
import { WorkflowDocument } from "./document";
import type { WorkflowContent } from "./model";
import { WorkflowRoom } from "./room";

// What the service does with a room is tested beside the service (shared-editing-service/server.test.ts); here
// is what a person in a room knows about it and about the others.

/** Someone who opens a workflow: their document, and their place in its room, which they leave when the test ends. */
async function open(user: TestUser, workflowId: number) {
  signInAs(user);
  const document = new WorkflowDocument();
  const room = new WorkflowRoom(document, workflowId, user.name);
  onTestFinished(() => room.leave());
  room.enter();
  await vi.waitFor(() => expect(room.state().entry).toBe("entered"));
  return { document, room };
}

function sharedWorkflow() {
  return addWorkflow(db, {
    name: "Iris",
    content: workflowContent([operator("PythonUDFV2", "udf")]),
    grants: [{ uid: reader.uid, privilege: "WRITE" }],
  });
}

describe("WorkflowRoom", () => {
  it("is outside the room until it is entered, and again once it is left", async () => {
    const { wid } = sharedWorkflow();
    signInAs(admin);
    const room = new WorkflowRoom(new WorkflowDocument(), wid, admin.name);
    expect(room.state()).toEqual({ entry: "entering", offline: false, save: "saved", collaborators: [] });
    expect(room.awareness).toBeUndefined();

    room.enter();
    await vi.waitFor(() => expect(room.state().entry).toBe("entered"));
    expect(room.awareness).toBeDefined();

    room.leave();
    expect(room.state().entry).toBe("entering");
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
