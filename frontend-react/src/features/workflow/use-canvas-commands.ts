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
import type { Selection } from "./components/workflow-canvas";

export interface CanvasCommands {
  copy: () => void;
  cut: () => void;
  /** Pastes what is on the clipboard, with its top left corner at a place, or else beside where it was. */
  paste: (at?: Point) => Promise<void>;
  duplicate: () => void;
  remove: () => void;
  /** Changes a switch of every selected operator. */
  patch: (patch: OperatorPatch) => void;
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
  /** Where the pointer is on the canvas, if it is there: what is pasted with a key goes there. */
  pointer: () => Point | undefined;
  /** What was pasted, to select and bring into view. */
  onPasted: (ids: string[]) => void;
}

/** Whether a key or a clipboard event is meant for a field being typed in, rather than for the canvas. */
const typing = (event: { target: EventTarget }) =>
  (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]") !== null;

/**
 * What can be done to what is selected on the canvas, from its menu or with the keyboard. The clipboard is the
 * system's, so a piece copied here pastes into another workflow, another tab, or the Angular app.
 */
export function useCanvasCommands({
  document,
  content,
  selection,
  schemas,
  readonly,
  pointer,
  onPasted,
}: CanvasCommandsOptions): CanvasCommands {
  const copied = () => pieceOf(content, selection);
  const nothingSelected = selection.operators.length + selection.commentBoxes.length === 0;

  function put(piece: WorkflowPiece, at?: Point) {
    const known = { ...piece, operators: piece.operators.filter(operator => schemas.has(operator.operatorType)) };
    const fresh = freshPiece(known, content, at);
    document.add(fresh);
    onPasted([
      ...fresh.operators.map(operator => operator.operatorID),
      ...fresh.commentBoxes.map(box => box.commentBoxID),
    ]);
  }

  const remove = () => document.remove(selection);

  return {
    copy: () => void navigator.clipboard.writeText(pieceText(copied())),
    cut: () => {
      void navigator.clipboard.writeText(pieceText(copied()));
      remove();
    },
    paste: async at => {
      const piece = readPiece(await navigator.clipboard.readText());
      if (piece) put(piece, at);
    },
    duplicate: () => put(copied()),
    remove,
    patch: patch => {
      for (const id of selection.operators) document.patchOperator(id, patch);
    },
    handlers: {
      onCopy: event => {
        if (typing(event) || nothingSelected) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", pieceText(copied()));
      },
      onCut: event => {
        if (typing(event) || nothingSelected || readonly) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", pieceText(copied()));
        remove();
      },
      onPaste: event => {
        if (typing(event) || readonly) return;
        const piece = readPiece(event.clipboardData.getData("text/plain"));
        if (!piece) return;
        event.preventDefault();
        put(piece, pointer());
      },
      onKeyDown: event => {
        if (typing(event) || readonly || nothingSelected) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          // Not the browser's bookmark.
          event.preventDefault();
          put(copied());
        }
      },
    },
  };
}
