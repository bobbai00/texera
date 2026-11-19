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

// What separates the values of a line of text: a single character where a file is read (a comma, a tab), or a
// regular expression where a text is split. A schema marks such a property with widget.formlyConfig.type
// "delimiter". Most people mean one of a few, some of which cannot be typed into a field, so those are offered
// by name.

export type DelimiterMode = "char" | "regex";

export interface DelimiterPreset {
  label: string;
  /** What the property holds when this one is chosen. */
  value: string;
}

export const delimiterPresets: Record<DelimiterMode, DelimiterPreset[]> = {
  char: [
    { label: "Comma ( , )", value: "," },
    { label: "Tab", value: "\t" },
    { label: "Semicolon ( ; )", value: ";" },
    { label: "Pipe ( | )", value: "|" },
    { label: "Space", value: " " },
  ],
  regex: [
    { label: "Comma ( , )", value: "," },
    { label: "Tab", value: String.raw`\t` },
    { label: "Semicolon ( ; )", value: ";" },
    { label: "Pipe ( | )", value: String.raw`\|` },
    { label: "Whitespace", value: String.raw`\s+` },
    { label: "New line", value: String.raw`\n` },
  ],
};

/** What is wrong with a delimiter that was typed, in words for the person who typed it. Undefined when nothing is. */
export function delimiterProblem(value: string, mode: DelimiterMode): string | undefined {
  if (value === "") return undefined;
  if (mode === "char") return value.length > 1 ? "A delimiter here is a single character." : undefined;
  try {
    // An expression that matches nothing at all would split a text between every two characters.
    return new RegExp(value).test("")
      ? "This expression matches an empty text, so it would split everywhere."
      : undefined;
  } catch {
    return "This is not a regular expression.";
  }
}
