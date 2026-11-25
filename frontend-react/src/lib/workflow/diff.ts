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

// What changed between two states of a workflow, in the terms a person reads it: the operators added, removed and
// changed (property by property), the links, the places, the comments and the settings. Operators, links and
// comment boxes are matched by their ids; what is in them is compared as JSON, whatever order its keys are in.

import type { CommentBox, Link, Operator, WorkflowContent } from "./model";

/** One value that changed: a property of an operator, a setting of the workflow, or one of an operator's own. */
export interface ValueChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface OperatorChange {
  /** The operator as it is after. */
  operator: Operator;
  /** Its properties that changed, as its JSON schema names them. */
  properties: ValueChange[];
  /** The operator's own values that changed, such as its name, whether it is disabled, and its ports. */
  fields: ValueChange[];
}

export interface WorkflowDiff {
  /** What was compared: the changes lead from before to after. */
  before: WorkflowContent;
  after: WorkflowContent;
  added: Operator[];
  removed: Operator[];
  changed: OperatorChange[];
  /** The ids of the operators that moved and did not change otherwise. */
  moved: string[];
  addedLinks: Link[];
  removedLinks: Link[];
  comments: { added: CommentBox[]; removed: CommentBox[]; changed: CommentBox[] };
  settings: ValueChange[];
}

/** How something on the canvas differs from what it is compared with. */
export type Mark = "added" | "removed" | "changed";

export interface Marks {
  operators: Record<string, Mark>;
  links: Record<string, Mark>;
}

// Neither is the user's change: the backend sets an operator's version to its build, and the editor alone reads
// whether the advanced properties are shown.
const notChanges = new Set(["operatorID", "operatorType", "operatorProperties", "operatorVersion", "showAdvanced"]);

export function diffContent(before: WorkflowContent, after: WorkflowContent): WorkflowDiff {
  const beforeOperators = byId(before.operators, operator => operator.operatorID);
  const afterOperators = byId(after.operators, operator => operator.operatorID);
  const changed: OperatorChange[] = [];
  const moved: string[] = [];
  for (const operator of after.operators) {
    const old = beforeOperators.get(operator.operatorID);
    if (!old) continue;
    const properties = valueChanges(old.operatorProperties, operator.operatorProperties);
    const fields = valueChanges(withoutIds(old), withoutIds(operator));
    if (properties.length + fields.length > 0) changed.push({ operator, properties, fields });
    else if (!sameValue(before.operatorPositions[old.operatorID], after.operatorPositions[operator.operatorID])) {
      moved.push(operator.operatorID);
    }
  }
  const beforeLinks = byId(before.links, link => link.linkID);
  const afterLinks = byId(after.links, link => link.linkID);
  const beforeBoxes = byId(before.commentBoxes, box => box.commentBoxID);
  const afterBoxes = byId(after.commentBoxes, box => box.commentBoxID);
  return {
    before,
    after,
    added: after.operators.filter(operator => !beforeOperators.has(operator.operatorID)),
    removed: before.operators.filter(operator => !afterOperators.has(operator.operatorID)),
    changed,
    moved,
    addedLinks: after.links.filter(link => !sameValue(link, beforeLinks.get(link.linkID))),
    removedLinks: before.links.filter(link => !sameValue(link, afterLinks.get(link.linkID))),
    comments: {
      added: after.commentBoxes.filter(box => !beforeBoxes.has(box.commentBoxID)),
      removed: before.commentBoxes.filter(box => !afterBoxes.has(box.commentBoxID)),
      changed: after.commentBoxes.filter(box => {
        const old = beforeBoxes.get(box.commentBoxID);
        return old !== undefined && !sameValue(old.comments, box.comments);
      }),
    },
    settings: valueChanges(before.settings, after.settings),
  };
}

export function isUnchanged(diff: WorkflowDiff): boolean {
  return summaryOf(diff)[0] === noChange;
}

const noChange = "No change";

/** The changes in a few words each, most telling first, such as ["Added Sort", "Changed Filter"]. */
export function summaryOf(diff: WorkflowDiff): string[] {
  const { added, removed, changed, moved, addedLinks, removedLinks, comments, settings } = diff;
  const names = (ids: string[]) => ids.map(id => nameOf(diff.after.operators.find(each => each.operatorID === id)!));
  const phrases = [
    named("Added", added.map(nameOf)),
    named("Removed", removed.map(nameOf)),
    named(
      "Changed",
      changed.map(change => nameOf(change.operator))
    ),
    counted("Added", addedLinks.length, "link"),
    counted("Removed", removedLinks.length, "link"),
    named("Moved", names(moved)),
    counted("Added", comments.added.length, "comment"),
    counted("Removed", comments.removed.length, "comment"),
    counted("Changed", comments.changed.length, "comment"),
    settings.length > 0 ? "Changed the settings" : undefined,
  ].filter(phrase => phrase !== undefined);
  return phrases.length > 0 ? phrases : [noChange];
}

/**
 * What to draw to show the changes: the workflow after them, with what they removed put back where it was, so
 * that it can be drawn as removed.
 */
export function shownWith(diff: WorkflowDiff): WorkflowContent {
  const { before, after, removed, removedLinks } = diff;
  return {
    ...after,
    operators: [...after.operators, ...removed],
    operatorPositions: {
      ...after.operatorPositions,
      ...Object.fromEntries(
        removed.map(operator => [operator.operatorID, before.operatorPositions[operator.operatorID]])
      ),
    },
    links: [...after.links.filter(link => !removedLinks.some(other => other.linkID === link.linkID)), ...removedLinks],
  };
}

/** How each operator and link that is drawn by shownWith() differs. What did not change has no mark. */
export function marksOf(diff: WorkflowDiff): Marks {
  const marked = <T>(items: T[], id: (item: T) => string, mark: Mark) =>
    items.map((item): [string, Mark] => [id(item), mark]);
  return {
    operators: Object.fromEntries([
      ...marked(diff.added, operator => operator.operatorID, "added"),
      ...marked(diff.removed, operator => operator.operatorID, "removed"),
      ...marked(diff.changed, change => change.operator.operatorID, "changed"),
    ]),
    links: Object.fromEntries([
      ...marked(diff.addedLinks, link => link.linkID, "added"),
      ...marked(diff.removedLinks, link => link.linkID, "removed"),
    ]),
  };
}

/** Whether two JSON values are the same, whatever order their keys are in. A key that is undefined is absent. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((each, index) => sameValue(each, b[index]))
    );
  }
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => sameValue(left[key], right[key]));
}

/**
 * The name an operator goes by in the summary of what a version changed, which knows no operator type: the one it
 * was given, or else its type's id. The canvas and the list of changes name it by its type's name where it has none.
 */
export function nameOf(operator: Operator): string {
  return operator.customDisplayName || operator.operatorType;
}

function valueChanges(before: object = {}, after: object = {}): ValueChange[] {
  const [left, right] = [before as Record<string, unknown>, after as Record<string, unknown>];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .filter(key => !sameValue(left[key], right[key]))
    .map(key => ({ key, before: left[key], after: right[key] }));
}

function withoutIds(operator: Operator): Record<string, unknown> {
  return Object.fromEntries(Object.entries(operator).filter(([key]) => !notChanges.has(key)));
}

function byId<T>(items: T[], id: (item: T) => string): Map<string, T> {
  return new Map(items.map(item => [id(item), item]));
}

/** "Added Sort", "Added Sort and Filter", or "Added 3 operators". Nothing for no operators. */
function named(verb: string, names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length <= 2) return `${verb} ${names.join(" and ")}`;
  return `${verb} ${names.length} operators`;
}

/** "Added a link", or "Added 3 links". Nothing for none. */
function counted(verb: string, count: number, noun: string): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? `${verb} a ${noun}` : `${verb} ${count} ${noun}s`;
}
