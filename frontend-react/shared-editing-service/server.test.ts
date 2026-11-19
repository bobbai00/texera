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

import { delay, http } from "msw";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { codeProperty } from "@/lib/workflow/code";
import { lineageOf, WorkflowDocument } from "@/lib/workflow/document";
import type { WorkflowContent } from "@/lib/workflow/model";
import { WorkflowRoom } from "@/lib/workflow/room";
import { roomName } from "@/lib/workflow/shared-editing";
import { admin, newcomer, reader, type TestUser } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { errorResponse } from "@/testing/mock-api/access";
import { openRooms, startSharedEditing } from "@/testing/mock-api/shared-editing";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { link, operator, piece, workflowContent } from "@/testing/workflow";

// The service is tested as it is used: people enter a workflow's room with the app's own WorkflowRoom, and the
// service works with the fake backend.

// Its operators are in the order of their ids, as a document gives them back.
const saved = workflowContent([operator("Limit", "limit"), operator("CSVFileScan", "scan")], [link("scan", "limit")]);

/** Someone who opens a workflow: their document, and their place in its room, which they leave when the test ends. */
async function open(user: TestUser, workflowId: number) {
  signInAs(user);
  const document = new WorkflowDocument();
  const room = new WorkflowRoom(document, workflowId, user.name);
  onTestFinished(() => room.leave());
  room.enter();
  await vi.waitFor(() => expect(room.state().entry).not.toBe("entering"));
  return { document, room };
}

const ids = (document: WorkflowDocument) => document.content().operators.map(each => each.operatorID);
const savedContent = (wid: number) =>
  JSON.parse(db.workflows.find(workflow => workflow.wid === wid)!.content) as WorkflowContent;
const sort = piece([operator("Sort", "sort")]);

describe("the shared editing service", () => {
  it("fills a room from the saved workflow for the first person, and gives the next one what the room holds", async () => {
    const { wid } = addWorkflow(db, {
      name: "Iris",
      content: saved,
      grants: [{ uid: reader.uid, privilege: "WRITE" }],
    });

    const ada = await open(admin, wid);
    expect(ada.room.state().entry).toBe("entered");
    expect(ada.document.content()).toEqual(saved);

    ada.document.add(sort);
    const grace = await open(reader, wid);

    expect(ids(grace.document)).toEqual(["limit", "scan", "sort"]);
  });

  it("passes each person's changes on to the others", async () => {
    const { wid } = addWorkflow(db, {
      name: "Iris",
      content: saved,
      grants: [{ uid: reader.uid, privilege: "WRITE" }],
    });
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);

    grace.document.add(sort);
    await vi.waitFor(() => expect(ids(ada.document)).toContain("sort"));
    ada.document.remove({ operators: ["limit"] });
    await vi.waitFor(() => expect(ids(grace.document)).toEqual(["scan", "sort"]));
  });

  it("saves the workflow a moment after it changed, and keeps the name it has by then", async () => {
    const workflow = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, workflow.wid);

    ada.document.add(sort);
    expect(ada.room.state().save).toBe("saving");
    workflow.name = "Iris, renamed elsewhere";

    await vi.waitFor(() => expect(ada.room.state().save).toBe("saved"));
    expect(savedContent(workflow.wid)).toEqual(ada.document.content());
    expect(workflow.name).toBe("Iris, renamed elsewhere");
    expect(workflow.saves).toHaveLength(2);
  });

  it("does not call saved what was changed while the workflow was being saved", async () => {
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, wid);
    // The backend takes a while over the first save: this handler waits, then leaves the answer to the usual one.
    server.use(http.post("/api/workflow/persist", () => delay(300).then(() => undefined), { once: true }));
    const savedIds = () => savedContent(wid).operators.map(each => each.operatorID);

    ada.document.add(sort);
    // What the backend had each time the room was called saved.
    const calledSaved: string[][] = [];
    ada.room.subscribe(() => {
      if (ada.room.state().save === "saved") calledSaved.push(savedIds());
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    ada.document.remove({ operators: ["limit"] });

    // The first save ends after the second change, and is not the last word: only the second save is.
    await vi.waitFor(() => expect(ada.room.state().save).toBe("saved"));
    expect(savedIds()).toEqual(["scan", "sort"]);
    expect(calledSaved).toEqual([["scan", "sort"]]);
  });

  it("saves what was not saved yet when the last person leaves", async () => {
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, wid);

    ada.document.add(sort);
    ada.room.leave();

    await vi.waitFor(() => expect(savedContent(wid).operators.map(each => each.operatorID)).toContain("sort"));
  });

  it("tells the room when the workflow could not be saved, and saves it with the next change", async () => {
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, wid);
    server.use(http.post("/api/workflow/persist", () => errorResponse(500, "The database is away."), { once: true }));

    ada.document.add(sort);
    await vi.waitFor(() => expect(ada.room.state().save).toBe("failed"));
    expect(ada.room.state().saveProblem).toContain("500");

    ada.document.remove({ operators: ["limit"] });
    await vi.waitFor(() => expect(ada.room.state().save).toBe("saved"));
    expect(savedContent(wid).operators.map(each => each.operatorID)).toEqual(["scan", "sort"]);
  });

  it("shows someone who may only look what the others do, and takes no change from them", async () => {
    const { wid } = addWorkflow(db, { name: "Iris", content: saved, grants: [{ uid: reader.uid, privilege: "READ" }] });
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);
    expect(grace.document.content()).toEqual(saved);

    grace.document.remove({ operators: ["scan"] });
    ada.document.add(sort);

    await vi.waitFor(() => expect(ids(grace.document)).toContain("sort"));
    expect(ids(ada.document)).toEqual(["limit", "scan", "sort"]);
    await vi.waitFor(() => expect(ada.room.state().save).toBe("saved"));
    expect(savedContent(wid).operators.map(each => each.operatorID)).toEqual(["limit", "scan", "sort"]);
  });

  it("refuses someone the backend does not let open the workflow", async () => {
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });

    const stranger = await open(newcomer, wid);

    expect(stranger.room.state().entry).toBe("refused");
    expect(ids(stranger.document)).toEqual([]);
  });

  it("keeps a room for a while after the last person has left, then fills it anew for whoever comes", async () => {
    startSharedEditing({ roomStaysMs: 300 });
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, wid);
    const lineage = lineageOf(ada.document.doc);
    expect(lineage).toBeDefined();
    ada.room.leave();

    // Coming back soon is coming back to the same room: a document that was in it goes back into it.
    const soon = await open(admin, wid);
    expect(lineageOf(soon.document.doc)).toBe(lineage);
    soon.room.leave();

    // Once the room has closed, the next person's is another filling of it, from the saved workflow.
    await new Promise(resolve => setTimeout(resolve, 600));
    const later = await open(admin, wid);
    expect(lineageOf(later.document.doc)).not.toBe(lineage);
    expect(later.document.content()).toEqual(saved);
  });

  it("keeps a room whose workflow could not be saved until it is saved, after the last person has left", async () => {
    startSharedEditing({ roomStaysMs: 100 });
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    let backendDown = true;
    server.use(
      http.post("/api/workflow/persist", () => (backendDown ? errorResponse(503, "The database is away.") : undefined))
    );
    const ada = await open(admin, wid);

    ada.document.add(sort);
    await vi.waitFor(() => expect(ada.room.state().save).toBe("failed"));
    ada.room.leave();
    // Long past the time a room stays: each time it was up, the room was saved again, and was not.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(openRooms()).toEqual([roomName(wid)]);

    backendDown = false;
    await vi.waitFor(() => expect(savedContent(wid).operators.map(each => each.operatorID)).toContain("sort"));
    await vi.waitFor(() => expect(openRooms()).toEqual([]));
  });

  it("lets go of the room of a workflow that was deleted, though what it holds can never be saved", async () => {
    startSharedEditing({ roomStaysMs: 100 });
    const { wid } = addWorkflow(db, { name: "Iris", content: saved });
    const ada = await open(admin, wid);
    db.workflows = db.workflows.filter(workflow => workflow.wid !== wid);
    db.resources = db.resources.filter(resource => resource.type !== "workflow" || resource.id !== wid);

    ada.document.add(sort);
    await vi.waitFor(() => expect(ada.room.state().save).toBe("failed"));
    ada.room.leave();

    await vi.waitFor(() => expect(openRooms()).toEqual([]));
  });

  it("keeps what two people type into one operator's code at the same time", async () => {
    const udf = operator("PythonUDFV2", "udf", { [codeProperty]: "yield tuple_\n" });
    const { wid } = addWorkflow(db, {
      name: "Iris",
      content: workflowContent([udf]),
      grants: [{ uid: reader.uid, privilege: "WRITE" }],
    });
    const ada = await open(admin, wid);
    const grace = await open(reader, wid);

    ada.document.code("udf")!.insert(0, "# by Ada\n");
    const end = grace.document.code("udf")!.length;
    grace.document.code("udf")!.insert(end, "# by Grace\n");

    const merged = "# by Ada\nyield tuple_\n# by Grace\n";
    await vi.waitFor(() => expect(ada.document.code("udf")!.toJSON()).toBe(merged));
    await vi.waitFor(() => expect(grace.document.code("udf")!.toJSON()).toBe(merged));
    await vi.waitFor(() => expect(savedContent(wid).operators[0].operatorProperties[codeProperty]).toBe(merged));
  });
});
