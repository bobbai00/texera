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

// Written out in full, so that the build finds each class. A label is white on the color, as tokens.css makes the
// colors for, in both themes.
const labels = [
  "bg-presence-1 text-white",
  "bg-presence-2 text-white",
  "bg-presence-3 text-white",
  "bg-presence-4 text-white",
  "bg-presence-5 text-white",
  "bg-presence-6 text-white",
];
const texts = [
  "text-presence-1",
  "text-presence-2",
  "text-presence-3",
  "text-presence-4",
  "text-presence-5",
  "text-presence-6",
];
const borders = [
  "border-presence-1",
  "border-presence-2",
  "border-presence-3",
  "border-presence-4",
  "border-presence-5",
  "border-presence-6",
];

/**
 * The classes that show something in the color of someone else in the room: a label of theirs, such as their name or
 * their avatar, on their color; text in it; or an edge in it, as of the card they are editing.
 */
export function presenceClassNames({ color }: { color: number }): { label: string; text: string; border: string } {
  return { label: labels[color - 1], text: texts[color - 1], border: borders[color - 1] };
}

const names = new Intl.ListFormat("en-US", { type: "conjunction" });

/** Some of the people in the room, at least one. */
type Holders = readonly [{ name: string }, ...{ name: string }[]];

/**
 * Who is editing what someone else holds (holds.ts), which is why it is not changed here, in two parts: who, and what
 * they do, as "Grace" and "is editing", so that where a label has little room the names are cut short, never what
 * they do. Of several operators: "Grace and Alan", "are editing". Each name is said once, as of someone's two tabs,
 * and someone whose browser tells no name is "Someone".
 */
export function editingParts(holders: Holders): [who: string, doing: string] {
  const named = [...new Set(holders.map(holder => holder.name.trim() || "Someone"))];
  return [names.format(named), named.length === 1 ? "is editing" : "are editing"];
}

/** Who is editing what someone else holds, in one line: "Grace is editing", or "Grace and Alan are editing". */
export function editingNotice(holders: Holders): string {
  return editingParts(holders).join(" ");
}
