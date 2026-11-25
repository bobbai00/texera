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

import type { ClipboardEvent, KeyboardEvent } from "react";
import { freshPiece, pieceOf, pieceText, readPiece } from "@/lib/workflow/clipboard";
import type { OperatorPatch, WorkflowDocument } from "@/lib/workflow/document";
import type { Point, WorkflowContent, WorkflowPiece } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";
import type { Collaborator } from "@/lib/workflow/room";
import type { Selection } from "./components/workflow-canvas";
import { typing } from "./keys";
import { editingNotice } from "./presence";

export interface CanvasCommands {
  copy: () => void;
  cut: () => void;
  /** Pastes what is on the clipboard, with its top left corner at a place, or else beside where it was. */
  paste: (at?: Point) => Promise<void>;
  duplicate: () => void;
  remove: () => void;
  /** Changes a switch of every selected operator that someone else does not hold. */
  patch: (patch: OperatorPatch) => void;
  /** Whether copying and duplicating have something to take: an operator or a comment box is selected. */
  canCopy: boolean;
  /** Whether cutting has something to take: an operator that someone else does not hold, or a comment box. */
  canCut: boolean;
  /** Whether removing has something to remove: what cutting would take, or a link. */
  canRemove: boolean;
  /**
   * What cutting, removing and the switches act on: what is selected, but for the operators someone else holds,
   * which they leave as they are. Copying and duplicating take all of it, as they change nothing that is there.
   */
  changeable: Selection;
  /** Who holds the selected operators that are left as they are, which is why: "Grace is editing". */
  leftAlone?: string;
  /** The handlers of the canvas's keys and clipboard events: what the keyboard does to the selection. */
  handlers: {
    onCopy: (event: ClipboardEvent) => void;
    onCut: (event: ClipboardEvent) => void;
    onPaste: (event: ClipboardEvent) => void;
    onKeyDown: (event: KeyboardEvent) => void;
  };
}

interface CanvasCommandsOptions {
  document: WorkflowDocument;
  content: WorkflowContent;
  selection: Selection;
  /** The operator types the backend offers: an operator of another type is not pasted. */
  schemas: Map<string, OperatorSchema>;
  readonly: boolean;
  /** The operators someone else holds, each with whoever holds it (holds.ts): theirs to change until they are done. */
  held: ReadonlyMap<string, Collaborator>;
  /** Where the pointer is on the canvas, if it is there: what is pasted with a key goes there. */
  pointer: () => Point | undefined;
  /** What was pasted, to select and bring into view. */
  onPasted: (ids: string[]) => void;
}

/**
 * What can be done to what is selected on the canvas, from its menu or with the keyboard. The clipboard is the
 * system's, so a piece copied here pastes into another workflow, another tab, or the Angular app. What is pressed,
 * copied or pasted in a field is the field's, and in a card open for editing the card's, which keeps it from the
 * canvas. What changes an operator leaves those that someone else is editing as they are, and acts on the rest; where
 * they stand and their links stay anyone's to change.
 */
export function useCanvasCommands({
  document,
  content,
  selection,
  schemas,
  readonly,
  held,
  pointer,
  onPasted,
}: CanvasCommandsOptions): CanvasCommands {
  const copied = (elements: Selection = selection) => pieceOf(content, elements);
  const canCopy = selection.operators.length + selection.commentBoxes.length > 0;
  const changeable = { ...selection, operators: selection.operators.filter(id => !held.has(id)) };
  const canCut = changeable.operators.length + changeable.commentBoxes.length > 0;
  const canRemove = canCut || changeable.links.length > 0;
  const [holder, ...holders] = selection.operators.flatMap(id => held.get(id) ?? []);

  function put(piece: WorkflowPiece, at?: Point) {
    const known = { ...piece, operators: piece.operators.filter(operator => schemas.has(operator.operatorType)) };
    const fresh = freshPiece(known, content, at);
    document.add(fresh);
    onPasted([
      ...fresh.operators.map(operator => operator.operatorID),
      ...fresh.commentBoxes.map(box => box.commentBoxID),
    ]);
  }

  const remove = () => document.remove(changeable);

  return {
    copy: () => void navigator.clipboard.writeText(pieceText(copied())),
    cut: () => {
      void navigator.clipboard.writeText(pieceText(copied(changeable)));
      remove();
    },
    paste: async at => {
      const piece = readPiece(await navigator.clipboard.readText());
      if (piece) put(piece, at);
    },
    duplicate: () => put(copied()),
    remove,
    patch: patch => {
      for (const id of changeable.operators) document.patchOperator(id, patch);
    },
    canCopy,
    canCut,
    canRemove,
    changeable,
    leftAlone: holder && editingNotice([holder, ...holders]),
    handlers: {
      onCopy: event => {
        if (typing(event.target) || !canCopy) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", pieceText(copied()));
      },
      onCut: event => {
        if (typing(event.target) || !canCut || readonly) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", pieceText(copied(changeable)));
        remove();
      },
      onPaste: event => {
        if (typing(event.target) || readonly) return;
        const piece = readPiece(event.clipboardData.getData("text/plain"));
        if (!piece) return;
        event.preventDefault();
        put(piece, pointer());
      },
      onKeyDown: event => {
        if (typing(event.target) || readonly || !canCopy) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          // Not the browser's bookmark.
          event.preventDefault();
          put(copied());
        }
      },
    },
  };
}
