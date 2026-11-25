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

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { codeLook, type Grammar, grammars } from "./code-look";

export interface CodeViewProps {
  /** What assistive technology calls the text. */
  label: string;
  code: string;
  /** How the text is highlighted. Plain text by default. */
  language?: Grammar;
  /** Whether long lines are wrapped, as prose and logs read best, rather than scrolled across, as code does. */
  wrap?: boolean;
}

/**
 * Code or text to read, such as a workflow written as Python or a file of a dataset: highlighted, with its lines
 * numbered and its blocks folded, searched with Ctrl or ⌘ and F, selectable, and not to be changed. It is CodeMirror,
 * which draws only the lines on the screen, so long text stays quick.
 */
export function CodeView({ label, code, language = "text", wrap = false }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: code,
        extensions: [
          basicSetup,
          grammars[language](),
          codeLook,
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({ "aria-label": label }),
          wrap ? EditorView.lineWrapping : [],
        ],
      }),
    });
    return () => view.destroy();
  }, [label, code, language, wrap]);

  return (
    <div
      ref={host}
      className="h-full min-h-0"
    />
  );
}
