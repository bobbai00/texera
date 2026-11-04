// The JSON Schema of every kind's spec, from the generated bundle, and the few questions
// the generic form asks of a schema.

import type { JsonSchema } from "@texera/workflow-model";
import { kindEntry, type KindId } from "../types";
import bundle from "../schema.gen.json";

const ROOT = bundle as unknown as JsonSchema & { $defs: Record<string, JsonSchema> };

/** A named schema of the bundle, e.g. `EnvironmentSpec`. */
export const definition = (name: string): JsonSchema | undefined => ROOT.$defs[name];

/** The schema of a kind's spec. */
export const specSchema = (kind: KindId): JsonSchema | undefined => definition(kindEntry(kind).spec);

/** Follows a `$ref` into the bundle; other schemas come back as they are. */
export function deref(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").at(-1) ?? "";
  const target = ROOT.$defs[name];
  return target ? { ...deref(target), ...(schema.description ? { description: schema.description } : {}) } : {};
}

export type FieldType = "string" | "enum" | "number" | "boolean" | "strings" | "map" | "object" | "json";

/** How the form renders a property. */
export function fieldType(schema: JsonSchema): FieldType {
  const s = deref(schema);
  const type = Array.isArray(s.type) ? s.type.find(t => t !== "null") : s.type;
  if (s.enum) return "enum";
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") {
    const items = s.items ? deref(s.items) : {};
    return items.type === "string" && !items.enum ? "strings" : "json";
  }
  if (type === "object") {
    if (s.properties) return "object";
    const extra = typeof s.additionalProperties === "object" ? deref(s.additionalProperties) : undefined;
    if (extra?.type === "string") return "map";
    return "json";
  }
  return "json";
}

/** The properties of an object schema in declaration order, required first. */
export function properties(schema: JsonSchema): [string, JsonSchema][] {
  const s = deref(schema);
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A value that satisfies the schema's required scalar fields, from defaults. */
export function emptyValue(schema: JsonSchema): Record<string, unknown> {
  const s = deref(schema);
  const out: Record<string, unknown> = {};
  for (const [key, prop] of properties(s)) {
    const p = deref(prop);
    if (!(s.required ?? []).includes(key)) continue;
    if (p.default !== undefined) out[key] = structuredClone(p.default);
    else {
      switch (fieldType(p)) {
        case "string":
          out[key] = "";
          break;
        case "enum":
          out[key] = p.enum?.[0];
          break;
        case "number":
          out[key] = 0;
          break;
        case "boolean":
          out[key] = false;
          break;
        case "strings":
          out[key] = [];
          break;
        case "map":
          out[key] = {};
          break;
        case "object":
          out[key] = emptyValue(p);
          break;
        default:
          out[key] = null;
      }
    }
  }
  return out;
}

/** The value with empty optional fields left out, so a saved spec carries only what was set. */
export function prune(value: unknown, schema: JsonSchema): unknown {
  const s = deref(schema);
  if (!isRecord(value) || fieldType(s) !== "object") return value;
  const required = new Set(s.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const prop = s.properties?.[key];
    const v = prop ? prune(raw, prop) : raw;
    const empty =
      v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);
    if (empty && !required.has(key)) continue;
    out[key] = v;
  }
  return out;
}
