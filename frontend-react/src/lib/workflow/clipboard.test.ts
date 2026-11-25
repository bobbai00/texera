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

import { describe, expect, it } from "vitest";
import { link, operator, workflowContent } from "@/testing/workflow";
import { freshPiece, pieceOf, pieceText, readPiece } from "./clipboard";
import type { CommentBox } from "./model";

const note: CommentBox = {
  commentBoxID: "note",
  commentBoxPosition: { x: 50, y: 200 },
  comments: [
    { content: "Check the units", creationTime: "2026-11-18T10:00:00.000Z", creatorName: "Ada", creatorID: 1 },
  ],
};
const content = {
  ...workflowContent(
    [operator("CSVFileScan", "scan"), operator("Filter", "filter"), operator("Limit", "limit")],
    [link("scan", "filter"), link("filter", "limit")]
  ),
  commentBoxes: [note],
};

describe("pieceOf", () => {
  it("takes the selected operators with their places, the links between them, and the selected comment boxes", () => {
    const piece = pieceOf(content, { operators: ["scan", "filter"], commentBoxes: ["note"] });

    expect(piece.operators.map(each => each.operatorID)).toEqual(["scan", "filter"]);
    expect(piece.operatorPositions).toEqual({ scan: { x: 0, y: 0 }, filter: { x: 300, y: 0 } });
    // The link to the Limit operator, which is not copied, stays behind.
    expect(piece.links).toEqual([link("scan", "filter")]);
    expect(piece.commentBoxes).toEqual([note]);
  });

  it("takes nothing that is not selected", () => {
    expect(pieceOf(content, {})).toEqual({ operators: [], operatorPositions: {}, links: [], commentBoxes: [] });
  });
});

describe("readPiece", () => {
  it("reads back what pieceText wrote", () => {
    const piece = pieceOf(content, { operators: ["scan", "filter"] });

    expect(readPiece(pieceText(piece))).toEqual(piece);
  });

  it("reads a piece the Angular app copied, which may leave out the parts it has none of", () => {
    const copied = JSON.stringify({
      operators: [operator("Limit", "limit")],
      operatorPositions: { limit: { x: 1, y: 2 } },
    });

    expect(readPiece(copied)).toEqual({
      operators: [operator("Limit", "limit")],
      operatorPositions: { limit: { x: 1, y: 2 } },
      links: [],
      commentBoxes: [],
    });
  });

  it.each([
    ["text that is not JSON", "select * from iris"],
    ["JSON that is not a piece of a workflow", '{"name": "Iris"}'],
    ["a piece with nothing in it", '{"operators": [], "commentBoxes": []}'],
    ["an operator without a type", '{"operators": [{"operatorID": "x"}]}'],
    ["a link without its ends", '{"operators": [], "links": [{"linkID": "l"}], "commentBoxes": [{}]}'],
    ["a list", "[1, 2]"],
  ])("finds no piece in %s", (_, text) => {
    expect(readPiece(text)).toBeUndefined();
  });
});

describe("freshPiece", () => {
  const piece = pieceOf(content, { operators: ["scan", "filter"], commentBoxes: ["note"] });

  it("gives everything a new id, and the links the new ids of their ends", () => {
    const fresh = freshPiece(piece, content);

    const [scan, filter] = fresh.operators;
    expect(scan.operatorID).toMatch(/^CSVFileScan-operator-/);
    expect(filter.operatorID).toMatch(/^Filter-operator-/);
    expect(scan.operatorProperties).toEqual(piece.operators[0].operatorProperties);
    expect(fresh.links).toHaveLength(1);
    expect(fresh.links[0].linkID).not.toBe(piece.links[0].linkID);
    expect(fresh.links[0].source).toEqual({ operatorID: scan.operatorID, portID: "output-0" });
    expect(fresh.links[0].target).toEqual({ operatorID: filter.operatorID, portID: "input-0" });
    expect(fresh.commentBoxes[0].commentBoxID).toMatch(/^commentBox-/);
    expect(fresh.commentBoxes[0].comments).toEqual(note.comments);
  });

  it("puts the piece's top left corner where it is pasted", () => {
    const fresh = freshPiece(piece, content, { x: 1000, y: 500 });

    const [scan, filter] = fresh.operators.map(each => fresh.operatorPositions[each.operatorID]);
    expect(scan).toEqual({ x: 1000, y: 500 });
    expect(filter).toEqual({ x: 1300, y: 500 });
    expect(fresh.commentBoxes[0].commentBoxPosition).toEqual({ x: 1050, y: 700 });
  });

  it("puts a piece pasted without a place beside where it was copied from, clear of what is there", () => {
    const once = freshPiece(piece, content);
    const scan = once.operatorPositions[once.operators[0].operatorID];
    expect(scan).toEqual({ x: 40, y: 40 });

    // A second paste of the same piece does not land on the first.
    const withOnce = { ...content, operatorPositions: { ...content.operatorPositions, ...once.operatorPositions } };
    const twice = freshPiece(piece, withOnce);
    expect(twice.operatorPositions[twice.operators[0].operatorID]).toEqual({ x: 80, y: 80 });
  });

  it("leaves out a link one of whose ends is not in the piece", () => {
    const stray = { ...piece, links: [...piece.links, link("filter", "elsewhere")] };

    expect(freshPiece(stray, content).links).toHaveLength(1);
  });
});
