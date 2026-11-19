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

// The theme on screen is the `dark` class on <html>, under which styles/tokens.css switches every
// color. The viewer's choice is remembered in this browser.

export type Theme = "light" | "dark";

const storageKey = "theme";
const listeners = new Set<() => void>();

/** The theme the viewer chose last, or else the one their system prefers. */
export function preferredTheme(): Theme {
  const stored = localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Shows a theme without remembering it: at start-up, and in Storybook's toolbar. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const listener of listeners) listener();
}

/** Shows the theme the viewer picked and remembers it. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(storageKey, theme);
  applyTheme(theme);
}

/** The theme on screen. */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Calls listener whenever the theme on screen changes. */
export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
