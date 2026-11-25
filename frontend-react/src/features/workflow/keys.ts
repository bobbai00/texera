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

import type { KeyboardEvent, SyntheticEvent } from "react";

/** What is typed in: a field, a list to choose from, or text that can be edited, as code is. */
const fields = "input, textarea, select, [contenteditable]";

/**
 * Whether what is pressed, copied, cut or pasted at `target` is meant for a field being typed in, rather than for
 * what is selected on the canvas or for the editor: there, Backspace deletes a character, Ctrl+A selects the field's
 * text and Ctrl+Z undoes what was typed.
 */
export const typing = (target: EventTarget | null) => target instanceof Element && target.closest(fields) !== null;

/** Whether a key undoes or redoes: ⌘Z and ⇧⌘Z on a Mac, Ctrl+Z and Shift+Ctrl+Z elsewhere. */
export const undoing = ({ key, metaKey, ctrlKey }: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
  (metaKey || ctrlKey) && key.toLowerCase() === "z";

/**
 * The keys held down while something else is pressed or clicked, which the canvas follows wherever they are pressed:
 * Ctrl or ⌘ held adds the operator chosen next to what is selected.
 */
const modifiers = new Set(["Control", "Meta", "Shift", "Alt"]);

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * What keeps something drawn on the canvas that is no part of the workflow, as an open card, or a chip and what it
 * opens (`chipEvents`), the only one to take what is pressed, copied, cut, pasted, right-clicked or clicked twice in
 * it: the canvas and the editor around it would act on what is selected. So Backspace in a card deletes a character,
 * never the operator, and a right click opens the browser's menu. Only the keys that undo go on, to the editor, which
 * undoes from anywhere, and the keys held down while something else is pressed, which the canvas follows. Its handlers
 * go on the element they keep, which may also do with the events what it does: `{...ownEvents}`.
 */
export const ownEvents = {
  onKeyDown: (event: KeyboardEvent) => {
    if (!undoing(event) && !modifiers.has(event.key)) event.stopPropagation();
  },
  onCopy: stop,
  onCut: stop,
  onPaste: stop,
  onContextMenu: stop,
  onDoubleClick: stop,
};

/**
 * Whether a key would have the browser act on the whole page, where the canvas acts on the whole workflow: Ctrl+A or
 * ⌘A selects all of the page's text, where the canvas selects every operator, and Ctrl+D or ⌘D bookmarks the page,
 * where the editor duplicates what is selected.
 */
const pageWide = ({ key, metaKey, ctrlKey }: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
  (metaKey || ctrlKey) && ["a", "d"].includes(key.toLowerCase());

/**
 * What keeps a chip on the canvas, and what it opens, their own, as `ownEvents` keeps an open card. The chip itself is
 * one of the canvas's buttons, as a card's are: the keys that would act on the whole page there act on the workflow
 * (`pageWide`). What it opens lies apart from it, under the page's body, as a list a field of an open card opens, and
 * keeps them, as that list does.
 */
export const chipEvents = {
  ...ownEvents,
  onKeyDown: (event: KeyboardEvent) => {
    const onChip = event.target instanceof Node && event.currentTarget.contains(event.target);
    if (!onChip || !pageWide(event)) ownEvents.onKeyDown(event);
  },
};
