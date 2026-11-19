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

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { applyTheme, preferredTheme, setTheme } from "./theme";

/** jsdom has no matchMedia; stand in for a system that prefers this color scheme. */
function systemPrefers(scheme: "light" | "dark") {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === `(prefers-color-scheme: ${scheme})` }));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

describe("preferredTheme", () => {
  it.each(["light", "dark"] as const)("is the viewer's last choice, %s", theme => {
    localStorage.setItem("theme", theme);

    expect(preferredTheme()).toBe(theme);
  });

  it.each(["light", "dark"] as const)("is the system's %s without a choice", scheme => {
    systemPrefers(scheme);

    expect(preferredTheme()).toBe(scheme);
  });

  it("ignores a stored value it does not know", () => {
    systemPrefers("dark");
    localStorage.setItem("theme", "sepia");

    expect(preferredTheme()).toBe("dark");
  });
});

describe("setTheme", () => {
  it("shows the dark theme and remembers it", () => {
    setTheme("dark");

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("shows the light theme and remembers it", () => {
    applyTheme("dark");

    setTheme("light");

    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("shows a theme without remembering it", () => {
    applyTheme("dark");

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBeNull();
  });
});
