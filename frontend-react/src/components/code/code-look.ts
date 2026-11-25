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

import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/legacy-modes/mode/javascript";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { r } from "@codemirror/legacy-modes/mode/r";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * The languages the app highlights, each parsed in the browser: an operator's code, and the files of a dataset. Plain
 * text has no grammar.
 */
export const grammars = {
  python,
  java,
  json,
  r: () => StreamLanguage.define(r),
  sql: () => StreamLanguage.define(standardSQL),
  javascript: () => StreamLanguage.define(javascript),
  shell: () => StreamLanguage.define(shell),
  yaml: () => StreamLanguage.define(yaml),
  toml: () => StreamLanguage.define(toml),
  xml: () => StreamLanguage.define(xml),
  properties: () => StreamLanguage.define(properties),
  text: (): Extension => [],
} satisfies Record<string, () => Extension>;

export type Grammar = keyof typeof grammars;

const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.self], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.comment], color: "var(--syntax-comment)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)],
    color: "var(--syntax-function)",
  },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "var(--syntax-type)" },
]);

/** How code looks wherever the app shows it: in the colors of the app's tokens, light or dark. */
export const codeLook: Extension = [
  syntaxHighlighting(colors),
  EditorView.theme({
    "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--background)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" },
    ".cm-gutters": { color: "var(--muted-foreground)", backgroundColor: "var(--muted)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)" },
    ".cm-cursor": { borderLeftColor: "var(--foreground)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "color-mix(in oklab, var(--primary) 25%, transparent)",
    },
    ".cm-tooltip": {
      color: "var(--popover-foreground)",
      backgroundColor: "var(--popover)",
      border: "1px solid var(--border)",
    },
  }),
];
