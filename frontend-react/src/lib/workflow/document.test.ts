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

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { link, operator, piece, workflowContent } from "@/testing/workflow";
import { codeProperty } from "./code";
import { isAt, lineageOf, progressOf, readContent, WorkflowDocument, writeContent } from "./document";
import type { Comment, CommentBox, WorkflowContent } from "./model";

/** A document holding scan -> filter -> limit. */
function pipeline() {
  const document = new WorkflowDocument();
  writeContent(
    document.doc,
    workflowContent(
      [operator("CSVFileScan", "scan"), operator("Filter", "filter"), operator("Limit", "limit", { limit: 10 })],
      [link("scan", "filter"), link("filter", "limit")]
    )
  );
  return document;
}

const ada: Comment = { content: "Use cm", creationTime: "2026-11-18T10:00:00.000Z", creatorName: "Ada", creatorID: 1 };
const grace: Comment = {
  content: "Looks right",
  creationTime: "2026-11-18T10:01:00.000Z",
  creatorName: "Grace",
  creatorID: 2,
};
const box: CommentBox = { commentBoxID: "commentBox-1", commentBoxPosition: { x: 9, y: 9 }, comments: [ada] };

const ids = (document: WorkflowDocument) => document.content().operators.map(({ operatorID }) => operatorID);
const linkIds = (document: WorkflowDocument) => document.content().links.map(({ linkID }) => linkID);

/** A document filled with a workflow, as the shared editing service fills one. */
function writtenAs(content: WorkflowContent): Y.Doc {
  const doc = new Y.Doc();
  writeContent(doc, content);
  return doc;
}

/** A second person's copy of a document, kept in step with it in both directions. */
function coEditorOf(document: WorkflowDocument) {
  const other = new WorkflowDocument();
  Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(document.doc));
  document.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "sync") Y.applyUpdate(other.doc, update, "sync");
  });
  other.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "sync") Y.applyUpdate(document.doc, update, "sync");
  });
  return other;
}

describe("WorkflowDocument", () => {
  it("gives back the workflow that was written into it, with the parts it does not draw", () => {
    const content = {
      ...workflowContent([operator("Limit", "limit"), operator("CSVFileScan", "scan")], [link("scan", "limit")]),
      settings: { dataTransferBatchSize: 100, executionMode: "MATERIALIZED" },
      formBinding: { fields: ["limit"] },
    };
    const document = new WorkflowDocument();

    writeContent(document.doc, content);

    expect(document.content()).toEqual(content);
    expect(readContent(document.doc)).toEqual(content);
  });

  it("holds an empty workflow before one is written into it", () => {
    expect(new WorkflowDocument().content()).toMatchObject({ operators: [], links: [], commentBoxes: [] });
  });

  it("returns the same content object until something changes", () => {
    const document = pipeline();
    const before = document.content();

    expect(document.content()).toBe(before);
    document.patchOperator("limit", { customDisplayName: "First ten" });

    expect(document.content()).not.toBe(before);
    expect(document.content().operators.find(({ operatorID }) => operatorID === "limit")?.customDisplayName).toBe(
      "First ten"
    );
  });

  it("tells its listeners of every change, until they stop listening", () => {
    const document = pipeline();
    const listener = vi.fn();
    const stop = document.subscribe(listener);

    document.move({ scan: { x: 5, y: 5 } });
    expect(listener).toHaveBeenCalled();

    stop();
    listener.mockClear();
    document.move({ scan: { x: 9, y: 9 } });
    expect(listener).not.toHaveBeenCalled();
  });

  it("adds operators with their places and the links between them", () => {
    const document = pipeline();

    document.add(
      piece([operator("Sort", "sort"), operator("Distinct", "distinct")], [link("sort", "distinct")], {
        sort: { x: 10, y: 20 },
        distinct: { x: 30, y: 40 },
      })
    );

    expect(ids(document)).toEqual(["distinct", "filter", "limit", "scan", "sort"]);
    expect(document.content().operatorPositions.sort).toEqual({ x: 10, y: 20 });
    expect(linkIds(document)).toContain("sort->distinct:0");
  });

  it("removes an operator with its place and every link on it", () => {
    const document = pipeline();

    document.remove({ operators: ["filter"] });

    expect(ids(document)).toEqual(["limit", "scan"]);
    expect(document.content().operatorPositions).not.toHaveProperty("filter");
    expect(linkIds(document)).toEqual([]);
  });

  it("removes a link and leaves its operators", () => {
    const document = pipeline();

    document.remove({ links: ["scan->filter:0"] });

    expect(linkIds(document)).toEqual(["filter->limit:0"]);
    expect(ids(document)).toEqual(["filter", "limit", "scan"]);
  });

  it("moves operators, and ignores the place of one that is not there", () => {
    const document = pipeline();

    document.move({ scan: { x: 1, y: 2 }, ghost: { x: 3, y: 4 } });

    expect(document.content().operatorPositions.scan).toEqual({ x: 1, y: 2 });
    expect(document.content().operatorPositions).not.toHaveProperty("ghost");
  });

  it("puts a pasted piece on the canvas with its comment boxes, as one step to undo", () => {
    const document = pipeline();

    document.add({ ...piece([operator("Sort", "sort")], [link("limit", "sort")]), commentBoxes: [box] });

    expect(ids(document)).toContain("sort");
    expect(linkIds(document)).toContain("limit->sort:0");
    expect(document.content().commentBoxes).toEqual([box]);
    document.undo();
    expect(ids(document)).toEqual(["filter", "limit", "scan"]);
    expect(document.content().commentBoxes).toEqual([]);
  });

  it("moves comment boxes as it moves operators", () => {
    const document = pipeline();
    document.add({ commentBoxes: [box] });

    document.move({ scan: { x: 1, y: 2 }, [box.commentBoxID]: { x: 5, y: 6 } });

    expect(document.content().operatorPositions.scan).toEqual({ x: 1, y: 2 });
    expect(document.content().commentBoxes[0].commentBoxPosition).toEqual({ x: 5, y: 6 });
  });

  it("starts a comment box with its first comment, and adds the replies after it", () => {
    const document = pipeline();

    const boxId = document.addCommentBox({ x: 40, y: 80 }, ada);
    document.addComment(boxId, grace);

    expect(document.content().commentBoxes).toEqual([
      { commentBoxID: boxId, commentBoxPosition: { x: 40, y: 80 }, comments: [ada, grace] },
    ]);
  });

  it("keeps both of two comments made in one box at the same moment", () => {
    const mine = pipeline();
    const boxId = mine.addCommentBox({ x: 0, y: 0 }, ada);
    const theirs = new WorkflowDocument();
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));

    // Neither has heard of the other's comment yet.
    mine.addComment(boxId, { ...ada, creationTime: "2026-11-18T10:05:00.000Z", content: "Mine" });
    theirs.addComment(boxId, grace);
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));
    Y.applyUpdate(mine.doc, Y.encodeStateAsUpdate(theirs.doc));

    expect(
      mine
        .content()
        .commentBoxes[0].comments.map(comment => comment.content)
        .toSorted()
    ).toEqual(["Mine", "Looks right", "Use cm"].toSorted());
    expect(theirs.content()).toEqual(mine.content());
  });

  it("changes what a comment says, removes one, and removes a box with its last comment", () => {
    const document = pipeline();
    const boxId = document.addCommentBox({ x: 0, y: 0 }, ada);
    document.addComment(boxId, grace);

    document.editComment(boxId, ada, "Use mm");
    expect(document.content().commentBoxes[0].comments).toEqual([{ ...ada, content: "Use mm" }, grace]);

    document.removeComment(boxId, grace);
    expect(document.content().commentBoxes[0].comments).toEqual([{ ...ada, content: "Use mm" }]);
    document.removeComment(boxId, ada);
    expect(document.content().commentBoxes).toEqual([]);
  });

  it("restores an earlier workflow in place of what is there, as one step to undo", () => {
    const document = pipeline();
    const original = document.content();
    const earlier = {
      ...workflowContent(
        [operator("CSVFileScan", "scan"), operator("Filter", "filter", { predicates: [] }), operator("Sort", "sort")],
        [link("scan", "filter"), link("filter", "sort")]
      ),
      commentBoxes: [box],
      settings: { dataTransferBatchSize: 1000 },
    };

    document.restore(earlier);

    expect(document.content()).toEqual(readContent(writtenAs(earlier)));
    document.undo();
    expect(document.content()).toEqual(original);
  });

  it("retypes only the letters of code that differ, in the text that is there, so whoever has it open stays in it", () => {
    const document = pipeline();
    document.add(piece([operator("PythonUDFV2", "udf", { [codeProperty]: "x = 1\nyield tuple_\n" })]));
    const text = document.code("udf")!;
    const changes: unknown[] = [];
    text.observe(event => changes.push(event.delta));

    const content = document.content();
    document.restore({
      ...content,
      operators: content.operators.map(each =>
        each.operatorID === "udf" ? { ...each, operatorProperties: { [codeProperty]: "x = 2\nyield tuple_\n" } } : each
      ),
    });

    expect(document.code("udf")).toBe(text);
    expect(text.toJSON()).toBe("x = 2\nyield tuple_\n");
    expect(changes).toEqual([[{ retain: 4 }, { delete: 1 }, { insert: "2" }]]);
  });

  it("leaves someone else's change to a part that the restored workflow has the same", () => {
    const mine = pipeline();
    const theirs = new WorkflowDocument();
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));
    const earlier = {
      ...mine.content(),
      operators: mine.content().operators.filter(each => each.operatorID !== "limit"),
    };

    // Neither has heard of the other's change yet.
    theirs.setOperatorProperty("scan", "fileName", "iris.csv");
    mine.restore(earlier);
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));
    Y.applyUpdate(mine.doc, Y.encodeStateAsUpdate(theirs.doc));

    expect(ids(mine)).toEqual(["filter", "scan"]);
    expect(mine.content().operators.find(each => each.operatorID === "scan")?.operatorProperties).toMatchObject({
      fileName: "iris.csv",
    });
  });

  it("links two ports, and refuses a link that is not allowed", () => {
    const document = pipeline();
    document.add(piece([operator("Sort", "sort")]));

    document.link(link("limit", "sort"));

    expect(linkIds(document)).toContain("limit->sort:0");
    expect(() => document.link({ ...link("limit", "sort"), linkID: "again" })).toThrow("linked already");
  });

  it("sets one property of an operator, and clears one", () => {
    const document = pipeline();
    const properties = () =>
      document.content().operators.find(({ operatorID }) => operatorID === "limit")?.operatorProperties;

    document.setOperatorProperty("limit", "limit", 25);
    document.setOperatorProperty("limit", "note", "keep");
    expect(properties()).toEqual({ limit: 25, note: "keep" });

    document.setOperatorProperty("limit", "note", undefined);
    expect(properties()).toEqual({ limit: 25 });
  });

  it("keeps an operator's code as text to type into, and saves it as the property it is", () => {
    const document = pipeline();
    document.add(piece([operator("PythonUDFV2", "udf", { [codeProperty]: "yield tuple_\n" })]));
    const saved = () => document.content().operators.find(({ operatorID }) => operatorID === "udf")?.operatorProperties;

    document.code("udf")!.insert(0, "# mine\n");
    expect(saved()).toMatchObject({ [codeProperty]: "# mine\nyield tuple_\n" });

    // The code is typed, never set: a form that reports it changes nothing.
    document.setOperatorProperty("udf", codeProperty, "replaced");
    expect(saved()).toMatchObject({ [codeProperty]: "# mine\nyield tuple_\n" });
    expect(document.code("scan")).toBeUndefined();
  });

  it("keeps two people's changes to different properties of one operator, made at the same moment", () => {
    const mine = pipeline();
    const theirs = new WorkflowDocument();
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));
    const properties = (document: WorkflowDocument) =>
      document.content().operators.find(({ operatorID }) => operatorID === "scan")?.operatorProperties;

    // Neither has heard of the other's change yet.
    mine.setOperatorProperty("scan", "fileName", "iris.csv");
    theirs.setOperatorProperty("scan", "hasHeader", false);
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));
    Y.applyUpdate(mine.doc, Y.encodeStateAsUpdate(theirs.doc));

    expect(properties(mine)).toMatchObject({ fileName: "iris.csv", hasHeader: false });
    expect(theirs.content()).toEqual(mine.content());
  });

  it("adds a port to an operator and removes it again, with the links on it", () => {
    const document = pipeline();
    document.add(piece([operator("PythonUDFV2", "udf")]));
    const inputPorts = () =>
      document
        .content()
        .operators.find(({ operatorID }) => operatorID === "udf")
        ?.inputPorts.map(({ portID }) => portID);

    document.addPort("udf", "input");
    document.link(link("limit", "udf", 1));
    expect(inputPorts()).toEqual(["input-0", "input-1"]);

    document.removePort("udf", "input");
    expect(inputPorts()).toEqual(["input-0"]);
    expect(linkIds(document)).not.toContain("limit->udf:1");
  });

  it("does not remove a port that the operator type came with", () => {
    const document = pipeline();

    document.removePort("filter", "input");

    expect(document.content().operators.find(({ operatorID }) => operatorID === "filter")?.inputPorts).toHaveLength(1);
  });

  it("undoes and redoes this user's changes, one step at a time", async () => {
    const document = pipeline();
    expect(document.history()).toEqual({ canUndo: false, canRedo: false });

    document.remove({ operators: ["limit"] });
    // Changes made within a moment of each other are one step; these two are apart.
    await new Promise(resolve => setTimeout(resolve, 350));
    document.patchOperator("scan", { isDisabled: true });
    expect(document.history()).toEqual({ canUndo: true, canRedo: false });

    document.undo();
    expect(document.content().operators.find(({ operatorID }) => operatorID === "scan")?.isDisabled).toBe(false);
    expect(ids(document)).toEqual(["filter", "scan"]);

    document.undo();
    expect(ids(document)).toEqual(["filter", "limit", "scan"]);
    expect(linkIds(document)).toEqual(["filter->limit:0", "scan->filter:0"]);
    expect(document.history()).toEqual({ canUndo: false, canRedo: true });

    document.redo();
    expect(ids(document)).toEqual(["filter", "scan"]);
  });

  it("does not undo someone else's change", () => {
    const mine = pipeline();
    const theirs = coEditorOf(mine);

    theirs.remove({ operators: ["limit"] });

    expect(ids(mine)).toEqual(["filter", "scan"]);
    expect(mine.history().canUndo).toBe(false);
    mine.undo();
    expect(ids(mine)).toEqual(["filter", "scan"]);
  });

  it("saves the same content whoever added an operator first", () => {
    const mine = new WorkflowDocument();
    const theirs = coEditorOf(mine);

    theirs.add(piece([operator("Limit", "b")]));
    mine.add(piece([operator("Limit", "a")]));

    expect(ids(mine)).toEqual(["a", "b"]);
    expect(JSON.stringify(theirs.content())).toBe(JSON.stringify(mine.content()));
  });

  it("starts a lineage each time a document is filled, also from the same workflow", () => {
    const first = pipeline();
    const second = pipeline();

    expect(lineageOf(new WorkflowDocument().doc)).toBeUndefined();
    expect(lineageOf(first.doc)).toBeDefined();
    expect(lineageOf(second.doc)).not.toBe(lineageOf(first.doc));
    expect(second.content()).toEqual(first.content());
  });

  it("marks how far a document has come, to tell whether another is exactly there", () => {
    const mine = pipeline();
    const theirs = coEditorOf(mine);
    const mark = progressOf(theirs.doc);
    expect(isAt(mine.doc, mark)).toBe(true);

    // Something put in is beyond the mark, and so is something taken out.
    mine.patchOperator("limit", { customDisplayName: "First ten" });
    expect(isAt(mine.doc, mark)).toBe(false);
    const renamed = progressOf(theirs.doc);
    expect(isAt(mine.doc, renamed)).toBe(true);
    mine.remove({ operators: ["limit"] });
    expect(isAt(mine.doc, renamed)).toBe(false);
    expect(isAt(mine.doc, progressOf(theirs.doc))).toBe(true);
  });
});
