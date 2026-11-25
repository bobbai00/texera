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

import { describe, expect, it } from "vitest";
import { type ResourceKindInfo, resourceKinds } from "./kinds";

// What WCAG 2.1 asks of colors: text, as small as a chip's, 4.5:1 against what is under it (1.4.3), and the edge
// that shows where a control is 3:1 against what is beside it (1.4.11).
const forText = 4.5;
const forEdges = 3;
// How far apart in OKLab two colors are to be told apart at a glance: well over 0.02, the least difference the eye
// notices, as CSS Color 4 counts it.
const apart = 0.05;
// The other colors the canvas means something by: what is selected and a result (primary), how an operator did
// (success, warning, destructive), and who else is there (presence).
const meanings = ["primary", "success", "warning", "destructive", ...[1, 2, 3, 4, 5, 6].map(n => `presence-${n}`)];

/** What the test takes from Node, which runs it, though the app's code is typed for a browser. */
interface NodeGlobal {
  process: { getBuiltinModule(id: "node:fs"): { readFileSync: (path: URL, encoding: "utf8") => string } };
}
// Vitest gives a test that imports a stylesheet none of its text, so the test reads the stylesheets as files. Vite
// takes `new URL(path, import.meta.url)` for the address of an asset and rewrites it, so this file's own address is
// named apart.
const { readFileSync } = (globalThis as unknown as NodeGlobal).process.getBuiltinModule("node:fs");
const here = import.meta.url;
const stylesheet = (name: string) => readFileSync(new URL(`../../styles/${name}`, here), "utf8");
const tokens = stylesheet("tokens.css");
const globals = stylesheet("globals.css");

type Theme = "light" | "dark";
/** A color in sRGB, each channel from 0 to 1. */
type Rgb = [number, number, number];
/** A color in OKLab: its lightness, and how far it lies from grey along each of the two axes of hue. */
type Lab = [number, number, number];

/** The tokens of a theme by name: those of :root, and in the dark theme those of .dark over them. */
function tokensOf(theme: Theme): Map<string, string> {
  const block = (selector: string) => {
    const body = new RegExp(`^${selector} \\{([^}]*)\\}`, "m").exec(tokens)?.[1] ?? "";
    return [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()] as const);
  };
  return new Map([...block(":root"), ...(theme === "dark" ? block("\\.dark") : [])]);
}

/** The value of a token in a theme. */
function valueOf(token: string, theme: Theme): string {
  const value = tokensOf(theme).get(token);
  if (!value) throw new Error(`The ${theme} theme has no ${token}.`);
  return value;
}

/** The token a color class paints with: the one that globals.css maps its color to. */
function tokenOf(className: string): string {
  const color = /^(?:text|border)-([\w-]+)$/.exec(className)?.[1];
  const token = color && new RegExp(`--color-${color}: var\\((--[\\w-]+)\\);`).exec(globals)?.[1];
  if (!token) throw new Error(`${className} is not the color of a token.`);
  return token;
}

/** An oklch() color in OKLab. */
function oklabOf(color: string): Lab {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!match) throw new Error(`${color} is not a color this check reads.`);
  const [lightness, chroma, hue] = match.slice(1).map(Number);
  return [lightness, chroma * Math.cos((hue * Math.PI) / 180), chroma * Math.sin((hue * Math.PI) / 180)];
}

/** How far apart two oklch() colors are in OKLab. */
function distance(one: string, other: string): number {
  const [l1, a1, b1] = oklabOf(one);
  const [l2, a2, b2] = oklabOf(other);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** An oklch() color in sRGB. One that sRGB cannot show fails the check: each browser would draw it its own way. */
function srgbOf(color: string): Rgb {
  const [lightness, a, b] = oklabOf(color);
  // From OKLab to linear sRGB, by the matrices of OKLab's author, Björn Ottosson.
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (linear.some(channel => channel < -0.001 || channel > 1.001)) throw new Error(`sRGB cannot show ${color}.`);
  return linear.map(channel => {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

/** WCAG 2.1's relative luminance of a color. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1's contrast ratio of two colors, from 1 to 21. */
function contrast(one: Rgb, other: Rgb): number {
  const [lighter, darker] = [luminance(one), luminance(other)].toSorted((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const toned = Object.entries<ResourceKindInfo>(resourceKinds).flatMap(([kind, { tone }]) =>
  tone ? [{ kind, tone }] : []
);

describe("the colors of the kinds", () => {
  it("are those of the datasets and the models, which operators read", () => {
    expect(toned.map(({ kind }) => kind)).toEqual(["dataset", "model"]);
  });

  it.each(toned)("draw $kind in its own token", ({ kind, tone }) => {
    expect(tone).toEqual({ text: `text-kind-${kind}`, border: `border-kind-${kind}` });
    expect(tokenOf(tone.text)).toBe(`--kind-${kind}`);
    expect(tokenOf(tone.border)).toBe(`--kind-${kind}`);
  });

  describe.each<Theme>(["light", "dark"])("in the %s theme", theme => {
    const surface = (name: string) => srgbOf(valueOf(`--${name}`, theme));
    const colorOf = (className: string) => srgbOf(valueOf(tokenOf(className), theme));

    it.each(toned)("draw $kind text that reads on a card, a popover and under the pointer", ({ tone }) => {
      for (const name of ["card", "popover", "accent"]) {
        expect(contrast(colorOf(tone.text), surface(name)), `${tone.text} on ${name}`).toBeGreaterThanOrEqual(forText);
      }
    });

    it.each(toned)("draw a $kind border that shows on a card, beside the canvas and under the pointer", ({ tone }) => {
      for (const name of ["card", "background", "accent"]) {
        expect(contrast(colorOf(tone.border), surface(name)), `${tone.border} on ${name}`).toBeGreaterThanOrEqual(
          forEdges
        );
      }
    });

    it.each(toned)("give $kind a color told apart from every other the canvas means something by", ({ kind }) => {
      const own = valueOf(`--kind-${kind}`, theme);
      const others = [...meanings, ...toned.filter(other => other.kind !== kind).map(other => `kind-${other.kind}`)];
      for (const name of others) {
        expect(distance(own, valueOf(`--${name}`, theme)), `--kind-${kind} from --${name}`).toBeGreaterThanOrEqual(
          apart
        );
      }
    });
  });
});
