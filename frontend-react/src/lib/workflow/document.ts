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

// The workflow being edited, as a Yjs document, so that several people can edit it at once and each of them can
// undo their own changes. Everything on the canvas is read and changed through this module; nothing else touches
// the Yjs types. The shared editing service fills the document from the saved workflow and saves what it holds
// (readContent, writeContent); the app changes it (WorkflowDocument).
//
// How much of a change is kept when two people change the same thing at once:
//   operators, links, positions   one by one: adding, moving or removing one leaves the others
//   an operator's properties      one by one: two people changing different properties both keep their change
//   an operator's code            letter by letter: two people typing in one piece of code both keep their typing
//   the comments in a box         one by one: two people commenting at once both keep their comment

import * as Y from "yjs";
import { codeLanguage, codeProperty } from "./code";
import { sameValue } from "./diff";
import { linkProblem, nextPortId } from "./links";
import type {
  Comment,
  CommentBox,
  Link,
  Operator,
  Point,
  WorkflowContent,
  WorkflowPiece,
  WorkflowSettings,
} from "./model";
import { emptyContent } from "./model";

/** The parts of an operator that are changed as a whole. Its properties are changed with setOperatorProperties. */
export type OperatorPatch = Partial<
  Pick<
    Operator,
    "customDisplayName" | "isDisabled" | "viewResult" | "markedForReuse" | "showAdvanced" | "operatorVersion"
  >
>;

/** What can be removed from the canvas together. */
export interface ElementIds {
  operators?: string[];
  links?: string[];
  commentBoxes?: string[];
}

/** Which comment of a box: the one its author made at that moment. */
export type CommentRef = Pick<Comment, "creatorID" | "creationTime">;

/** Whether there is a change of this user's to undo or to redo. */
export interface History {
  canUndo: boolean;
  canRedo: boolean;
}

const contentKeys = new Set(["operators", "operatorPositions", "links", "commentBoxes"]);

/** Where each part of a workflow is kept in a Yjs document. */
function partsOf(doc: Y.Doc) {
  return {
    operators: doc.getMap<Y.Map<unknown>>("operators"),
    positions: doc.getMap<Point>("positions"),
    links: doc.getMap<Link>("links"),
    commentBoxes: doc.getMap<Y.Map<unknown>>("commentBoxes"),
    /** The settings, and every other part of the content that is not drawn, such as the Form View's formBinding. */
    rest: doc.getMap<unknown>("rest"),
  };
}

/** The workflow a Yjs document holds, as it is saved. */
export function readContent(doc: Y.Doc): WorkflowContent {
  const { operators, positions, links, commentBoxes, rest } = partsOf(doc);
  return {
    ...emptyContent,
    ...(rest.toJSON() as Partial<WorkflowContent>),
    // In the order of their ids, so that the saved content does not depend on who added what first.
    operators: sortedValues(operators.toJSON() as Record<string, Operator>),
    operatorPositions: positions.toJSON(),
    links: sortedValues(links.toJSON() as Record<string, Link>),
    commentBoxes: sortedValues(commentBoxes.toJSON() as Record<string, CommentBox>),
  };
}

/**
 * Puts a saved workflow into a Yjs document, in place of what it holds. It is nobody's change to undo.
 *
 * Each filling starts a lineage. Two documents filled from the same saved workflow hold the same workflow, but
 * Yjs cannot know that: bringing them together keeps one filling's operators or the other's by chance, and with
 * the loser goes whatever was changed in it. So a document is only ever brought together with documents of its
 * own lineage, which lineageOf() names.
 */
export function writeContent(doc: Y.Doc, content: WorkflowContent): void {
  const { operators, positions, links, commentBoxes, rest } = partsOf(doc);
  doc.transact(() => {
    doc.getMap<string>("room").set("lineage", crypto.randomUUID());
    for (const map of [operators, positions, links, commentBoxes, rest]) map.clear();
    for (const operator of content.operators) operators.set(operator.operatorID, sharedOperator(operator));
    for (const [id, position] of Object.entries(content.operatorPositions)) positions.set(id, position);
    for (const link of content.links) links.set(link.linkID, link);
    for (const box of content.commentBoxes) commentBoxes.set(box.commentBoxID, sharedCommentBox(box));
    for (const [key, value] of Object.entries(content)) if (!contentKeys.has(key)) rest.set(key, value);
  });
}

/** The filling that a document's content came from. Undefined for a document that was never filled. */
export function lineageOf(doc: Y.Doc): string | undefined {
  return doc.getMap<string>("room").get("lineage");
}

/**
 * How far a document has come: everything put into it and everything taken out of it, as a mark to compare
 * another document against.
 */
export function progressOf(doc: Y.Doc): string {
  return btoa(String.fromCharCode(...Y.encodeSnapshot(Y.snapshot(doc))));
}

/** Whether a document is exactly as far as a mark: nothing was put into it or taken out of it since. */
export function isAt(doc: Y.Doc, progress: string): boolean {
  const mark = Y.decodeSnapshot(Uint8Array.from(atob(progress), character => character.charCodeAt(0)));
  return Y.equalSnapshots(Y.snapshot(doc), mark);
}

export class WorkflowDocument {
  readonly doc: Y.Doc;
  private readonly operators: Y.Map<Y.Map<unknown>>;
  private readonly positions: Y.Map<Point>;
  private readonly links: Y.Map<Link>;
  private readonly commentBoxes: Y.Map<Y.Map<unknown>>;
  private readonly rest: Y.Map<unknown>;
  private readonly undoManager: Y.UndoManager;
  private readonly listeners = new Set<() => void>();
  private cachedContent: WorkflowContent | undefined;
  private cachedHistory: History = { canUndo: false, canRedo: false };

  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    ({
      operators: this.operators,
      positions: this.positions,
      links: this.links,
      commentBoxes: this.commentBoxes,
      rest: this.rest,
    } = partsOf(doc));
    // Only this user's own changes are undone: they are the ones made with this document as their origin.
    this.undoManager = new Y.UndoManager([this.operators, this.positions, this.links, this.commentBoxes, this.rest], {
      trackedOrigins: new Set([this]),
      captureTimeout: 300,
    });
    doc.on("update", this.changed);
    this.undoManager.on("stack-item-added", this.changed);
    this.undoManager.on("stack-item-popped", this.changed);
    this.undoManager.on("stack-cleared", this.changed);
  }

  /** Calls listener whenever the content or the history changes, by this user or by anyone else. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The workflow as it is saved. The same object is returned until something changes. */
  content = (): WorkflowContent => (this.cachedContent ??= readContent(this.doc));

  history = (): History => this.cachedHistory;

  /**
   * The code of an operator that is written as code, as text that several people can type in at once. The code
   * editor changes it directly; those changes are undone in the code editor, not on the canvas.
   */
  code(operatorId: string): Y.Text | undefined {
    const properties = this.operators.get(operatorId)?.get("operatorProperties") as Y.Map<unknown> | undefined;
    const code = properties?.get(codeProperty);
    return code instanceof Y.Text ? code : undefined;
  }

  /**
   * Types into an operator's code at a place, as the code editor does, as when a parameter is declared in it from
   * the operator's properties. Unlike what is typed in the code editor, it is undone with the canvas's changes.
   */
  typeCode(operatorId: string, offset: number, text: string): void {
    const code = this.code(operatorId);
    if (code) this.change(() => code.insert(offset, text));
  }

  /**
   * Puts a piece on the canvas: one operator from the menu, or what is pasted, with the links between its
   * operators and its comment boxes. An operator without a place goes to the top left.
   */
  add({ operators = [], operatorPositions = {}, links = [], commentBoxes = [] }: Partial<WorkflowPiece>): void {
    this.change(() => {
      for (const operator of operators) {
        this.operators.set(operator.operatorID, sharedOperator(operator));
        this.positions.set(operator.operatorID, operatorPositions[operator.operatorID] ?? { x: 0, y: 0 });
      }
      for (const link of links) this.links.set(link.linkID, link);
      for (const box of commentBoxes) this.commentBoxes.set(box.commentBoxID, sharedCommentBox(box));
    });
  }

  /** Removes operators, links and comment boxes. A link goes with either of its operators. */
  remove({ operators = [], links = [], commentBoxes = [] }: ElementIds): void {
    this.change(() => {
      const gone = new Set(operators);
      for (const id of operators) {
        this.operators.delete(id);
        this.positions.delete(id);
      }
      for (const [id, link] of this.links) {
        if (links.includes(id) || gone.has(link.source.operatorID) || gone.has(link.target.operatorID)) {
          this.links.delete(id);
        }
      }
      for (const id of commentBoxes) this.commentBoxes.delete(id);
    });
  }

  /** Moves operators and comment boxes to new places on the canvas, each by its id. */
  move(positions: Record<string, Point>): void {
    this.change(() => {
      for (const [id, position] of Object.entries(positions)) {
        if (this.operators.has(id)) this.positions.set(id, position);
        this.commentBoxes.get(id)?.set("commentBoxPosition", position);
      }
    });
  }

  /** Starts a comment box at a place on the canvas, with its first comment, and returns the box's id. */
  addCommentBox(position: Point, comment: Comment): string {
    const commentBoxID = `commentBox-${crypto.randomUUID()}`;
    this.change(() =>
      this.commentBoxes.set(
        commentBoxID,
        sharedCommentBox({ commentBoxID, commentBoxPosition: position, comments: [comment] })
      )
    );
    return commentBoxID;
  }

  /** Adds a comment at the end of a box. */
  addComment(boxId: string, comment: Comment): void {
    const comments = this.commentsOf(boxId);
    if (comments) this.change(() => comments.push([comment]));
  }

  /** Changes what a comment says. Who made it, and when, stays. */
  editComment(boxId: string, ref: CommentRef, content: string): void {
    const comments = this.commentsOf(boxId);
    const index = comments ? indexOf(comments, ref) : -1;
    if (!comments || index < 0) return;
    this.change(() => {
      const comment = comments.get(index);
      comments.delete(index);
      comments.insert(index, [{ ...comment, content }]);
    });
  }

  /** Removes a comment. A box whose last comment goes goes with it. */
  removeComment(boxId: string, ref: CommentRef): void {
    const comments = this.commentsOf(boxId);
    const index = comments ? indexOf(comments, ref) : -1;
    if (!comments || index < 0) return;
    this.change(() => {
      comments.delete(index);
      if (comments.length === 0) this.commentBoxes.delete(boxId);
    });
  }

  /** Links two ports. It refuses a link that linkProblem() names a problem with. */
  link(link: Link): void {
    const problem = linkProblem(this.content(), link.source, link.target);
    if (problem) throw new Error(problem);
    this.change(() => this.links.set(link.linkID, link));
  }

  /**
   * Sets one property of an operator, or clears it. Someone else's change to another property at the same moment
   * stays. The code of an operator is not set here: it is typed into, through code().
   */
  setOperatorProperty(operatorId: string, key: string, value: unknown): void {
    const properties = this.operators.get(operatorId)?.get("operatorProperties") as Y.Map<unknown> | undefined;
    if (!properties || properties.get(key) instanceof Y.Text) return;
    this.change(() => {
      if (value === undefined) properties.delete(key);
      else properties.set(key, value);
    });
  }

  /** Changes an operator's name, or turns one of its switches on or off. */
  patchOperator(operatorId: string, patch: OperatorPatch): void {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    this.change(() => {
      for (const [key, value] of Object.entries(patch)) operator.set(key, value);
    });
  }

  /** Adds a port to a side of an operator that lets its user add ports. */
  addPort(operatorId: string, side: "input" | "output"): void {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    const key = side === "input" ? "inputPorts" : "outputPorts";
    const ports = operator.get(key) as Operator["inputPorts"];
    const port = { portID: nextPortId(ports, side), displayName: "", disallowMultiInputs: false, isDynamicPort: true };
    this.change(() => operator.set(key, [...ports, port]));
  }

  /** Removes the last port of a side of an operator, with the links on it, if the user added that port. */
  removePort(operatorId: string, side: "input" | "output"): void {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    const key = side === "input" ? "inputPorts" : "outputPorts";
    const ports = operator.get(key) as Operator["inputPorts"];
    const last = ports.at(-1);
    if (!last?.isDynamicPort) return;
    this.change(() => {
      operator.set(key, ports.slice(0, -1));
      for (const [id, link] of this.links) {
        const end = side === "input" ? link.target : link.source;
        if (end.operatorID === operatorId && end.portID === last.portID) this.links.delete(id);
      }
    });
  }

  /**
   * Puts a whole workflow in place of what is there, as when an earlier version is restored: one step to undo,
   * and one change to everyone else. Only what differs is changed, so that someone changing a part that is the
   * same keeps their change, and code that differs is retyped where it differs, so that whoever has it open
   * keeps their place.
   */
  restore(content: WorkflowContent): void {
    this.change(() => {
      const operators = new Map(content.operators.map(operator => [operator.operatorID, operator]));
      for (const id of [...this.operators.keys()]) if (!operators.has(id)) this.operators.delete(id);
      for (const operator of content.operators) {
        const shared = this.operators.get(operator.operatorID);
        if (shared) restoreOperator(shared, operator);
        else this.operators.set(operator.operatorID, sharedOperator(operator));
      }
      restoreMap(this.positions, content.operatorPositions);
      restoreMap(this.links, Object.fromEntries(content.links.map(link => [link.linkID, link])));
      const boxes = new Map(content.commentBoxes.map(box => [box.commentBoxID, box]));
      for (const id of [...this.commentBoxes.keys()]) if (!boxes.has(id)) this.commentBoxes.delete(id);
      for (const box of content.commentBoxes) {
        if (!sameValue(this.commentBoxes.get(box.commentBoxID)?.toJSON(), box)) {
          this.commentBoxes.set(box.commentBoxID, sharedCommentBox(box));
        }
      }
      restoreMap(this.rest, Object.fromEntries(Object.entries(content).filter(([key]) => !contentKeys.has(key))));
    });
  }

  setSettings(settings: WorkflowSettings): void {
    this.change(() => this.rest.set("settings", settings));
  }

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  /** Stops following the Yjs document. The document itself is the caller's to destroy. */
  destroy(): void {
    this.doc.off("update", this.changed);
    this.undoManager.destroy();
    this.listeners.clear();
  }

  private commentsOf(boxId: string): Y.Array<Comment> | undefined {
    return this.commentBoxes.get(boxId)?.get("comments") as Y.Array<Comment> | undefined;
  }

  /** Makes a change of this user's: one step to everyone else, and one step to undo. */
  private change(write: () => void): void {
    this.doc.transact(write, this);
  }

  private readonly changed = (): void => {
    this.cachedContent = undefined;
    const canUndo = this.undoManager.undoStack.length > 0;
    const canRedo = this.undoManager.redoStack.length > 0;
    if (canUndo !== this.cachedHistory.canUndo || canRedo !== this.cachedHistory.canRedo) {
      this.cachedHistory = { canUndo, canRedo };
    }
    for (const listener of this.listeners) listener();
  };
}

/** An operator as it is kept in the document: its properties one by one, its code as text, the rest as it is. */
function sharedOperator({ operatorProperties, ...operator }: Operator): Y.Map<unknown> {
  const shared = new Y.Map<unknown>(Object.entries(operator));
  const properties = new Y.Map<unknown>(Object.entries(operatorProperties));
  const code = operatorProperties[codeProperty];
  if (codeLanguage(operator.operatorType) && typeof code === "string") properties.set(codeProperty, new Y.Text(code));
  shared.set("operatorProperties", properties);
  return shared;
}

/** Makes a shared operator what an operator is, changing only what differs. */
function restoreOperator(shared: Y.Map<unknown>, { operatorProperties, ...operator }: Operator): void {
  const properties = shared.get("operatorProperties") as Y.Map<unknown>;
  for (const key of [...shared.keys()]) if (key !== "operatorProperties" && !(key in operator)) shared.delete(key);
  for (const [key, value] of Object.entries(operator)) if (!sameValue(shared.get(key), value)) shared.set(key, value);
  for (const key of [...properties.keys()]) if (!(key in operatorProperties)) properties.delete(key);
  for (const [key, value] of Object.entries(operatorProperties)) {
    const current = properties.get(key);
    if (current instanceof Y.Text && typeof value === "string") retype(current, value);
    else if (!sameValue(current, value)) properties.set(key, value);
  }
}

/** Makes a map hold exactly these values, changing only those that differ. */
function restoreMap<T>(map: Y.Map<T>, values: Record<string, T>): void {
  for (const key of [...map.keys()]) if (!(key in values)) map.delete(key);
  for (const [key, value] of Object.entries(values)) if (!sameValue(map.get(key), value)) map.set(key, value);
}

/** Changes text into other text where the two differ, keeping what they begin and end with alike. */
function retype(text: Y.Text, wanted: string): void {
  const current = text.toJSON();
  if (current === wanted) return;
  let start = 0;
  while (start < current.length && start < wanted.length && current[start] === wanted[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < wanted.length - start &&
    current[current.length - 1 - end] === wanted[wanted.length - 1 - end]
  ) {
    end++;
  }
  text.delete(start, current.length - start - end);
  text.insert(start, wanted.slice(start, wanted.length - end));
}

/** A comment box as it is kept in the document: its comments one by one, the rest as it is. */
function sharedCommentBox({ comments, ...box }: CommentBox): Y.Map<unknown> {
  const shared = new Y.Map<unknown>(Object.entries(box));
  shared.set("comments", Y.Array.from(comments));
  return shared;
}

function indexOf(comments: Y.Array<Comment>, { creatorID, creationTime }: CommentRef): number {
  return comments.toArray().findIndex(each => each.creatorID === creatorID && each.creationTime === creationTime);
}

function sortedValues<T>(byId: Record<string, T>): T[] {
  return Object.keys(byId)
    .sort()
    .map(id => byId[id]);
}
