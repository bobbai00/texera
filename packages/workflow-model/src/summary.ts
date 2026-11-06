// What an operator's card says about its settings: one line per setting that says something,
// in words a person would use. A file is its name, a list of conditions reads as written,
// code is its length, a credential is never shown, and what was left at its default says
// nothing.

import { same } from "./same";
import { fieldKind, isHidden, orderedProperties, resolve } from "./schema";
import type { JsonSchema } from "./types";

export interface PropertyLine {
  key: string;
  /** The setting's name, as the schema titles it. */
  label: string;
  /** What it is set to, to be read beside its name. */
  value: string;
  /** What it is set to, to be read without its name: a number or a switch says its name itself. */
  short: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const titleOf = (key: string, schema: JsonSchema) =>
  (schema.title ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, c => c.toUpperCase()))
    .replace(/\s+/g, " ")
    .trim();

/** The last part of a path or of a dataset file's URI. */
const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** A value in words; "" when it says nothing. */
function words(key: string, raw: JsonSchema, value: unknown, root: JsonSchema): string {
  if (value === undefined || value === null || value === "") return "";
  const schema = resolve(raw, root);
  const kind = fieldKind(key, raw, root);
  if (kind === "credential") return "a credential";
  if (typeof value === "string") {
    if (kind === "file" || kind === "datasetVersion") return baseName(value);
    if (kind === "code") {
      const lines = value.split("\n").length;
      return `${lines} line${lines === 1 ? "" : "s"} of code`;
    }
    return value;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value))
    return value
      .map(item => words(key, schema.items ?? {}, item, root))
      .filter(Boolean)
      .join(", ");
  if (isRecord(value)) {
    // An object's own values side by side, in the schema's order: "medal = Gold".
    const named = orderedProperties(schema);
    const keys = named.length ? named.map(([k]) => k) : Object.keys(value);
    return keys
      .map(k => words(k, schema.properties?.[k] ?? {}, value[k], root))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** The settings of an operator that say something, in the schema's order. */
export function describeProperties(schema: JsonSchema, values: Record<string, unknown>): PropertyLine[] {
  const object = resolve(schema, schema);
  const siblings = object.properties ?? {};
  const lines: PropertyLine[] = [];
  for (const [key, raw] of orderedProperties(object)) {
    if (isHidden(key, raw, schema, values, siblings)) continue;
    const prop = resolve(raw, schema);
    const value = values[key];
    // A switch that is off and was never on by default says nothing.
    if (value === false && prop.default !== true) continue;
    if (prop.default !== undefined && same(value, prop.default)) continue;
    const said = words(key, raw, value, schema);
    if (!said) continue;
    const label = titleOf(key, prop);
    const short =
      typeof value === "number"
        ? `${label} ${said}`
        : typeof value === "boolean"
          ? value
            ? label
            : `no ${label}`
          : said;
    lines.push({ key, label, value: said, short });
  }
  return lines;
}

/** The first settings side by side, for a card that has one line for them. */
export function summarize(lines: PropertyLine[], most = 2): string {
  return lines
    .slice(0, most)
    .map(l => l.short)
    .join(" · ");
}
