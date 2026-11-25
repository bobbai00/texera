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

import {
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  LayoutGridIcon,
  MessageSquarePlusIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import type { Operator } from "@/lib/workflow/model";
import type { CanvasCommands } from "../use-canvas-commands";
import type { CanvasTarget, Selection } from "./workflow-canvas";

export interface CanvasMenuProps {
  target: CanvasTarget;
  selection: Selection;
  /** The selected operators. */
  operators: Operator[];
  commands: CanvasCommands;
  readonly: boolean;
  /** Starts a comment at the place the menu was opened. */
  onComment: () => void;
  onArrange: () => void;
  /** More items for one selected operator, from another feature, such as executing the workflow up to it. */
  operatorItems?: ReactNode;
}

// The key that goes with a letter for a shortcut: ⌘ on a Mac, Ctrl elsewhere.
const modifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/** The items of the canvas's menu: what can be done to what is selected, or at the place on the empty canvas. */
export function CanvasMenu({
  target,
  selection,
  operators,
  commands,
  readonly,
  onComment,
  onArrange,
  operatorItems,
}: CanvasMenuProps) {
  if (!target.onSelection) {
    return readonly ? (
      <ContextMenuItem disabled>Nothing to do here</ContextMenuItem>
    ) : (
      <>
        <ContextMenuItem onSelect={() => void commands.paste(target.at)}>
          <ClipboardPasteIcon />
          Paste here
          <ContextMenuShortcut>{modifier}V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onComment}>
          <MessageSquarePlusIcon />
          Comment here
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onArrange}>
          <LayoutGridIcon />
          Arrange the operators
        </ContextMenuItem>
      </>
    );
  }

  const copyable = selection.operators.length + selection.commentBoxes.length > 0;
  const all = (key: "isDisabled" | "viewResult") => operators.length > 0 && operators.every(operator => operator[key]);
  return (
    <>
      <ContextMenuItem
        disabled={!copyable}
        onSelect={commands.copy}>
        <CopyIcon />
        Copy
        <ContextMenuShortcut>{modifier}C</ContextMenuShortcut>
      </ContextMenuItem>
      {!readonly && (
        <>
          <ContextMenuItem
            disabled={!copyable}
            onSelect={commands.cut}>
            <ScissorsIcon />
            Cut
            <ContextMenuShortcut>{modifier}X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!copyable}
            onSelect={commands.duplicate}>
            <CopyPlusIcon />
            Duplicate
            <ContextMenuShortcut>{modifier}D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={commands.remove}>
            <Trash2Icon />
            Delete
            <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </>
      )}
      {!readonly && operators.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={all("viewResult")}
            onCheckedChange={checked => commands.patch({ viewResult: checked })}>
            Keep {operators.length === 1 ? "its result" : "their results"}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={all("isDisabled")}
            onCheckedChange={checked => commands.patch({ isDisabled: checked })}>
            Leave out of executions
          </ContextMenuCheckboxItem>
        </>
      )}
      {operators.length === 1 && operatorItems && (
        <>
          <ContextMenuSeparator />
          {operatorItems}
        </>
      )}
    </>
  );
}
