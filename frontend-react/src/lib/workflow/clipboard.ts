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

// What is copied from a canvas and pasted into one: a piece of a workflow, as JSON text on the system clipboard,
// so that it pastes into another workflow, another tab, or the Angular app, which copies the same shape.

import type { ElementIds } from "./document";
import type { CommentBox, Link, Operator, Point, WorkflowContent, WorkflowPiece } from "./model";
import { newLinkId, newOperatorId } from "./operator-schema";

/** How far a piece pasted without a place moves from where it was, each time it would land on something. */
const pasteStep = 40;

/** The selected operators with their places, the links between any two of them, and the selected comment boxes. */
export function pieceOf(content: WorkflowContent, { operators = [], commentBoxes = [] }: ElementIds): WorkflowPiece {
  const ids = new Set(operators);
  return {
    operators: content.operators.filter(operator => ids.has(operator.operatorID)),
    operatorPositions: Object.fromEntries(Object.entries(content.operatorPositions).filter(([id]) => ids.has(id))),
    links: content.links.filter(link => ids.has(link.source.operatorID) && ids.has(link.target.operatorID)),
    commentBoxes: content.commentBoxes.filter(box => commentBoxes.includes(box.commentBoxID)),
  };
}

/** A piece as the text that goes on the clipboard. */
export function pieceText(piece: WorkflowPiece): string {
  return JSON.stringify(piece);
}

/** The piece that text from the clipboard holds, or undefined when it holds none, as for text from elsewhere. */
export function readPiece(text: string): WorkflowPiece | undefined {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(read)) return undefined;
  const { operators = [], operatorPositions = {}, links = [], commentBoxes = [] } = read;
  const valid =
    Array.isArray(operators) &&
    operators.every(isOperator) &&
    isObject(operatorPositions) &&
    Array.isArray(links) &&
    links.every(isLink) &&
    Array.isArray(commentBoxes) &&
    commentBoxes.every(isCommentBox);
  if (!valid || operators.length + commentBoxes.length === 0) return undefined;
  return {
    operators,
    operatorPositions: operatorPositions as WorkflowPiece["operatorPositions"],
    links,
    commentBoxes,
  };
}

/**
 * A piece made new, to be pasted into a workflow: each operator, link and comment box with an id of its own. It
 * is moved so that its top left corner is at `at`, or else down and to the right of where it was copied from,
 * far enough that none of its operators lands on one of the workflow's. A link one of whose ends is not in the
 * piece is left out.
 */
export function freshPiece(piece: WorkflowPiece, content: WorkflowContent, at?: Point): WorkflowPiece {
  const newIds = new Map(piece.operators.map(operator => [operator.operatorID, newOperatorId(operator.operatorType)]));
  const places = [
    ...piece.operators.map(operator => piece.operatorPositions[operator.operatorID] ?? { x: 0, y: 0 }),
    ...piece.commentBoxes.map(box => box.commentBoxPosition),
  ];
  const offset = at ? offsetTo(places, at) : clearOffset(piece, content);
  const moved = (place: Point): Point => ({ x: place.x + offset.x, y: place.y + offset.y });

  const operators = piece.operators.map((operator): Operator => ({
    ...operator,
    operatorID: newIds.get(operator.operatorID)!,
  }));
  const links = piece.links.flatMap((link): Link[] => {
    const source = newIds.get(link.source.operatorID);
    const target = newIds.get(link.target.operatorID);
    if (!source || !target) return [];
    return [
      {
        linkID: newLinkId(),
        source: { ...link.source, operatorID: source },
        target: { ...link.target, operatorID: target },
      },
    ];
  });
  return {
    operators,
    operatorPositions: Object.fromEntries(
      piece.operators.map(operator => [
        newIds.get(operator.operatorID)!,
        moved(piece.operatorPositions[operator.operatorID] ?? { x: 0, y: 0 }),
      ])
    ),
    links,
    commentBoxes: piece.commentBoxes.map((box): CommentBox => ({
      ...box,
      commentBoxID: `commentBox-${crypto.randomUUID()}`,
      commentBoxPosition: moved(box.commentBoxPosition),
    })),
  };
}

/** How far to move places so that the top left corner of all of them is at a point. */
function offsetTo(places: Point[], at: Point): Point {
  const left = Math.min(...places.map(place => place.x));
  const top = Math.min(...places.map(place => place.y));
  return { x: at.x - left, y: at.y - top };
}

/** The smallest step down and to the right that puts none of the piece's operators on one of the workflow's. */
function clearOffset(piece: WorkflowPiece, content: WorkflowContent): Point {
  const taken = new Set(Object.values(content.operatorPositions).map(({ x, y }) => `${x},${y}`));
  const lands = (distance: number) =>
    piece.operators.some(operator => {
      const { x, y } = piece.operatorPositions[operator.operatorID] ?? { x: 0, y: 0 };
      return taken.has(`${x + distance},${y + distance}`);
    });
  let distance = pasteStep;
  while (lands(distance)) distance += pasteStep;
  return { x: distance, y: distance };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperator(value: unknown): value is Operator {
  return (
    isObject(value) &&
    typeof value.operatorID === "string" &&
    typeof value.operatorType === "string" &&
    isObject(value.operatorProperties) &&
    Array.isArray(value.inputPorts) &&
    Array.isArray(value.outputPorts)
  );
}

function isLink(value: unknown): value is Link {
  return isObject(value) && typeof value.linkID === "string" && isObject(value.source) && isObject(value.target);
}

function isCommentBox(value: unknown): value is CommentBox {
  return (
    isObject(value) &&
    typeof value.commentBoxID === "string" &&
    Array.isArray(value.comments) &&
    isObject(value.commentBoxPosition)
  );
}
