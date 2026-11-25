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

import { indentWithTab } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import { type Text, UndoManager } from "yjs";
import { codeLook, grammars } from "@/components/code/code-look";
import type { CodeLanguage } from "@/lib/workflow/code";

export interface CodeEditorProps {
  /** What assistive technology calls the editor. */
  label: string;
  /** The code, as text shared with whoever else has it open: what is typed here changes it directly. */
  text: Text;
  language: CodeLanguage;
  /** Where each person's cursor is in the code they have open. Without it nobody else's cursor shows. */
  awareness?: Awareness;
  readOnly?: boolean;
  /** What else the editor does with the code, such as asking a language server about it. */
  extensions?: Extension;
}

// One value for "nothing more", so that an editor without extensions is not made anew on every render.
const nothingMore: Extension = [];

// What was taken out is marked in the destructive color on the left, what was put in in the success color on
// the right.
const diffLook = EditorView.theme({
  "&": { height: "auto" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "color-mix(in oklab, var(--destructive) 10%, transparent)",
  },
  "&.cm-merge-b .cm-changedLine, .cm-insertedLine": {
    backgroundColor: "color-mix(in oklab, var(--success) 10%, transparent)",
  },
  "&.cm-merge-a .cm-changedText": { background: "color-mix(in oklab, var(--destructive) 30%, transparent)" },
  "&.cm-merge-b .cm-changedText": { background: "color-mix(in oklab, var(--success) 30%, transparent)" },
});

export interface CodeDiffProps {
  /** What assistive technology calls the two sides, after which it says which side each is. */
  label: string;
  before: string;
  after: string;
  language: CodeLanguage;
}

/** Two states of one operator's code side by side, with what changed between them marked, and the rest folded. */
export function CodeDiff({ label, before, after, language }: CodeDiffProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const side = (doc: string, which: string) => ({
      doc,
      extensions: [
        basicSetup,
        grammars[language](),
        codeLook,
        diffLook,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": `${label}, ${which}` }),
      ],
    });
    const view = new MergeView({
      a: side(before, "before"),
      b: side(after, "after"),
      parent: host.current!,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  }, [label, before, after, language]);

  return (
    <div
      ref={host}
      className="h-full min-h-0 overflow-auto"
    />
  );
}

/**
 * The editor of one operator's code. It shows the cursors of the other people typing in the same code, with
 * their names, and undoes only what this user typed.
 */
export function CodeEditor({
  label,
  text,
  language,
  awareness,
  readOnly = false,
  extensions = nothingMore,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(undefined);
  // What else the editor does can come late, as a language server's help does once it answers. It is put into
  // the editor that is there, so that whoever is typing keeps their place.
  const [more] = useState(() => new Compartment());

  useEffect(() => {
    const undoManager = new UndoManager(text);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.toJSON(),
        extensions: [
          // Undo and redo are the shared text's, which knows whose typing is whose; they come before the editor's.
          Prec.high(keymap.of(yUndoManagerKeymap)),
          basicSetup,
          keymap.of([indentWithTab]),
          grammars[language](),
          codeLook,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          yCollab(text, awareness ?? null, { undoManager }),
          more.of([]),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = undefined;
      view.destroy();
      undoManager.destroy();
      // The others no longer see a cursor in code this user has closed.
      awareness?.setLocalStateField("cursor", null);
    };
  }, [label, text, language, awareness, readOnly, more]);

  // After the effect above, so that an editor that was just made gets what else it does, too.
  useEffect(() => {
    editor.current?.dispatch({ effects: more.reconfigure(extensions) });
  }, [label, text, language, awareness, readOnly, more, extensions]);

  return (
    <div
      ref={host}
      className="h-full min-h-0"
    />
  );
}
