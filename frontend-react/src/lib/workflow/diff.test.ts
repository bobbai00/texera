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
import { diffContent, isUnchanged, marksOf, sameValue, shownWith, summaryOf } from "./diff";
import type { CommentBox, WorkflowContent } from "./model";

const scan = operator("CSVFileScan", "scan", { fileName: "/dataset/a@b.c/penguins/v1/penguins.csv" });
const filter = operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] });
const limit = operator("Limit", "limit", { limit: 5 });
const before = workflowContent([scan, filter, limit], [link("scan", "filter"), link("filter", "limit")]);

const note: CommentBox = {
  commentBoxID: "note",
  commentBoxPosition: { x: 0, y: 300 },
  comments: [{ content: "Grams?", creationTime: "2026-11-18T10:00:00.000Z", creatorName: "Ada", creatorID: 1 }],
};

/** The workflow before, changed by a function. */
function changed(change: (content: WorkflowContent) => void): WorkflowContent {
  const after = structuredClone(before);
  change(after);
  return after;
}

describe("diffContent", () => {
  it("finds nothing between a workflow and itself, whatever order its keys are in", () => {
    const reordered = changed(content => {
      // The same operator, with its keys in another order.
      const { operatorProperties, ...rest } = content.operators[2];
      content.operators[2] = { ...rest, operatorProperties: { ...operatorProperties } };
      content.operatorPositions = Object.fromEntries(Object.entries(content.operatorPositions).reverse());
    });

    expect(isUnchanged(diffContent(before, reordered))).toBe(true);
    expect(summaryOf(diffContent(before, reordered))).toEqual(["No change"]);
  });

  it("finds the operators that were added and removed, with the links that went with them", () => {
    const after = changed(content => {
      content.operators = content.operators.filter(each => each.operatorID !== "limit");
      delete content.operatorPositions.limit;
      content.links = [link("scan", "filter"), link("filter", "sort")];
      content.operators.push(operator("Sort", "sort"));
      content.operatorPositions.sort = { x: 600, y: 100 };
    });

    const diff = diffContent(before, after);

    expect(diff.added.map(each => each.operatorID)).toEqual(["sort"]);
    expect(diff.removed.map(each => each.operatorID)).toEqual(["limit"]);
    expect(diff.addedLinks.map(each => each.linkID)).toEqual(["filter->sort:0"]);
    expect(diff.removedLinks.map(each => each.linkID)).toEqual(["filter->limit:0"]);
    expect(summaryOf(diff)).toEqual(["Added Sort", "Removed Limit", "Added a link", "Removed a link"]);
  });

  it("says which properties of an operator changed, and how, and which of its own settings", () => {
    const after = changed(content => {
      content.operators[1].operatorProperties.predicates = [{ attribute: "mass", condition: ">", value: "4000" }];
      content.operators[2].operatorProperties.limit = 10;
      content.operators[2].customDisplayName = "First ten";
      content.operators[2].isDisabled = true;
    });

    const diff = diffContent(before, after);

    expect(diff.changed.map(each => each.operator.operatorID)).toEqual(["filter", "limit"]);
    expect(diff.changed[1].properties).toEqual([{ key: "limit", before: 5, after: 10 }]);
    expect(diff.changed[1].fields).toEqual([
      { key: "customDisplayName", before: "Limit", after: "First ten" },
      { key: "isDisabled", before: false, after: true },
    ]);
    expect(summaryOf(diff)).toEqual(["Changed Filter and First ten"]);
  });

  it("does not count what the backend changes on its own, nor what only the editor keeps, as a change", () => {
    const after = changed(content => {
      content.operators[0].operatorVersion = "a-newer-build";
      content.operators[0].showAdvanced = true;
    });

    expect(isUnchanged(diffContent(before, after))).toBe(true);
  });

  it("tells an operator that only moved from one that changed", () => {
    const after = changed(content => {
      content.operatorPositions.scan = { x: -100, y: 50 };
      content.operatorPositions.limit = { x: 900, y: 0 };
      content.operators[2].operatorProperties.limit = 10;
    });

    const diff = diffContent(before, after);

    expect(diff.moved).toEqual(["scan"]);
    expect(diff.changed.map(each => each.operator.operatorID)).toEqual(["limit"]);
    expect(summaryOf(diff)).toEqual(["Changed Limit", "Moved CSV File Scan"]);
  });

  it("finds comments added, removed and replied to, and the settings that changed", () => {
    const withNote = { ...before, commentBoxes: [note] };
    const replied = {
      ...withNote,
      commentBoxes: [{ ...note, comments: [...note.comments, { ...note.comments[0], content: "Yes" }] }],
      settings: { ...before.settings, dataTransferBatchSize: 1000 },
    };

    expect(diffContent(before, withNote).comments.added).toEqual([note]);
    expect(diffContent(withNote, before).comments.removed).toEqual([note]);
    const diff = diffContent(withNote, replied);
    expect(diff.comments.changed.map(box => box.commentBoxID)).toEqual(["note"]);
    expect(diff.settings).toEqual([{ key: "dataTransferBatchSize", before: 400, after: 1000 }]);
    expect(summaryOf(diff)).toEqual(["Changed a comment", "Changed the settings"]);
  });

  it("counts many operators rather than naming them all", () => {
    const after = changed(content => {
      for (const each of content.operators) each.operatorProperties.note = "changed";
    });

    expect(summaryOf(diffContent(before, after))).toEqual(["Changed 3 operators"]);
  });
});

describe("shownWith and marksOf", () => {
  it("puts what was removed back on the canvas, marked, beside what was added and changed", () => {
    const after = changed(content => {
      content.operators = content.operators.filter(each => each.operatorID !== "limit");
      delete content.operatorPositions.limit;
      content.links = [link("scan", "filter")];
      content.operators[1].operatorProperties.predicates = [];
      content.operators.push(operator("Sort", "sort"));
      content.operatorPositions.sort = { x: 600, y: 100 };
    });
    const diff = diffContent(before, after);

    const shown = shownWith(diff);

    expect(shown.operators.map(each => each.operatorID).toSorted()).toEqual(["filter", "limit", "scan", "sort"]);
    expect(shown.operatorPositions.limit).toEqual(before.operatorPositions.limit);
    expect(shown.links.map(each => each.linkID).toSorted()).toEqual(["filter->limit:0", "scan->filter:0"]);
    expect(marksOf(diff)).toEqual({
      operators: { sort: "added", limit: "removed", filter: "changed" },
      links: { "filter->limit:0": "removed" },
    });
  });
});

describe("sameValue", () => {
  it.each([
    [{ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 }, true],
    [[1, 2], [2, 1], false],
    [{ a: 1 }, { a: 1, b: undefined }, true],
    [{ a: null }, { a: undefined }, false],
    ["1", 1, false],
  ])("compares %j with %j as %s", (a, b, same) => {
    expect(sameValue(a, b)).toBe(same);
  });
});
