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

import { cn } from "cn";
import {
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  LayoutGridIcon,
  MessageSquarePlusIcon,
  PlayIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import type { Operator } from "@/lib/workflow/model";
import type { CanvasCommands } from "../use-canvas-commands";
import type { CanvasTarget, ExecutionUpTo } from "./workflow-canvas";

export interface CanvasMenuProps {
  target: CanvasTarget;
  /** The selected operators. */
  operators: Operator[];
  /** What can be done to what is selected, and whether it can be done now. */
  commands: CanvasCommands;
  readonly: boolean;
  /** Starts a comment at the place the menu was opened. */
  onComment: () => void;
  onArrange: () => void;
  /** Executing the workflow up to the one operator that is selected, which another feature does. */
  upTo?: ExecutionUpTo;
}

// The key that goes with a letter for a shortcut: ⌘ on a Mac, Ctrl elsewhere.
const modifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/**
 * The items of the canvas's menu: what can be done to what is selected, or at the place on the empty canvas. One
 * operator's result is kept with the eye on its card; the menu keeps the results of several at once. What would change
 * an operator someone else is editing leaves it as it is, and acts on the rest of what is selected; with nothing else
 * to act on, it cannot be chosen, and says who is editing. An item that cannot be chosen for a reason stays where the
 * keyboard goes, as the card's buttons do, and says why under its name; one with nothing to act on is passed over.
 */
export function CanvasMenu({ target, operators, commands, readonly, onComment, onArrange, upTo }: CanvasMenuProps) {
  const ids = useId();
  /** The id of the line under an item's name that says why the item cannot be chosen now, which describes it. */
  const reasonId = (item: string) => `${ids}-${item}`;
  /**
   * What an item that cannot be chosen now is given. With a reason, it stays where the keyboard goes, described by
   * why, and choosing it does nothing: the menu stays open. Without one, the menu passes over it.
   */
  const unavailable = (item: string, reason: string | undefined) =>
    reason === undefined
      ? { disabled: true }
      : {
          "aria-disabled": true,
          "aria-describedby": reasonId(item),
          className: "[&>svg]:opacity-50",
          onSelect: (event: Event) => event.preventDefault(),
        };
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

  const { canCopy, canCut, canRemove, changeable, leftAlone } = commands;
  // A switch says how the operators it changes are set, or, when it can change none of them, how the selected are.
  const switchable = operators.filter(operator => changeable.operators.includes(operator.operatorID));
  const canSwitch = switchable.length > 0;
  const switched = canSwitch ? switchable : operators;
  const all = (key: "isDisabled" | "viewResult") => switched.length > 0 && switched.every(operator => operator[key]);
  // Why an item that would change what is selected cannot be chosen: someone else is editing all of it. Cutting what
  // has nothing to copy has no reason.
  const cutReason = canCut || !canCopy ? undefined : leftAlone;
  const deleteReason = canRemove ? undefined : leftAlone;
  const switchReason = canSwitch ? undefined : leftAlone;
  const executeReason = upTo?.problem;
  return (
    <>
      <ContextMenuItem
        disabled={!canCopy}
        onSelect={commands.copy}>
        <CopyIcon />
        Copy
        <ContextMenuShortcut>{modifier}C</ContextMenuShortcut>
      </ContextMenuItem>
      {!readonly && (
        <>
          <ContextMenuItem
            onSelect={commands.cut}
            {...(canCut ? {} : unavailable("cut", cutReason))}>
            <ScissorsIcon />
            <Named
              reasonId={reasonId("cut")}
              reason={cutReason}>
              Cut
            </Named>
            <ContextMenuShortcut>{modifier}X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canCopy}
            onSelect={commands.duplicate}>
            <CopyPlusIcon />
            Duplicate
            <ContextMenuShortcut>{modifier}D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={commands.remove}
            {...(canRemove ? {} : unavailable("delete", deleteReason))}>
            <Trash2Icon />
            <Named
              reasonId={reasonId("delete")}
              reason={deleteReason}>
              Delete
            </Named>
            <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </>
      )}
      {!readonly && operators.length > 0 && (
        <>
          <ContextMenuSeparator />
          {operators.length > 1 && (
            <ContextMenuCheckboxItem
              checked={all("viewResult")}
              // The menu calls this even for a switch that waits, which then has no operator to change.
              onCheckedChange={checked => commands.patch({ viewResult: checked })}
              {...(canSwitch ? {} : unavailable("keep", switchReason))}>
              <Named
                reasonId={reasonId("keep")}
                reason={switchReason}>
                Keep their results
              </Named>
            </ContextMenuCheckboxItem>
          )}
          <ContextMenuCheckboxItem
            checked={all("isDisabled")}
            onCheckedChange={checked => commands.patch({ isDisabled: checked })}
            {...(canSwitch ? {} : unavailable("leave-out", switchReason))}>
            <Named
              reasonId={reasonId("leave-out")}
              reason={switchReason}>
              Leave out of executions
            </Named>
          </ContextMenuCheckboxItem>
        </>
      )}
      {operators.length === 1 && upTo && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={upTo.start}
            {...(executeReason === undefined ? {} : unavailable("execute", executeReason))}>
            <PlayIcon />
            <Named
              reasonId={reasonId("execute")}
              reason={executeReason}>
              Execute up to here
            </Named>
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

/**
 * An item's name, and under it why the item cannot be chosen now, if it cannot: the name is faded, and the reason is
 * not, to be read, as a menu shows no title. The reason describes the item, which names it by `reasonId`, and is no
 * part of its name.
 */
function Named({ reasonId, reason, children }: { reasonId: string; reason?: string; children: ReactNode }) {
  return (
    <span className="flex flex-col">
      <span className={cn(reason !== undefined && "opacity-50")}>{children}</span>
      {reason !== undefined && (
        <span
          id={reasonId}
          aria-hidden
          className="text-xs text-muted-foreground">
          {reason}
        </span>
      )}
    </span>
  );
}
