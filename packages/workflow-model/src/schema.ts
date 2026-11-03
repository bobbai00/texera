// How an operator's JSON Schema becomes a form: which fields show, in what order, and
// which control each gets. Pure functions over the schema; no schema compiler (Ajv
// compiles to `new Function`, which the app's CSP forbids).

import type { JsonSchema } from "./types";

/** Follows a local `$ref` (`#/definitions/Name`) against the operator's root schema. */
export function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace(/^#\/definitions\//, "");
  const target = root.definitions?.[name];
  return target ? { ...target, ...withoutRef(schema) } : schema;
}

function withoutRef({ $ref: _ref, ...rest }: JsonSchema): JsonSchema {
  return rest;
}

/** The schema's main type, ignoring "null" in a type list. */
export function primaryType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  return Array.isArray(t) ? t.find(x => x !== "null") : t;
}

/** Choices of an enum, or of a oneOf/anyOf made only of constants. */
export function choices(schema: JsonSchema): unknown[] | undefined {
  if (schema.enum) return schema.enum;
  const options = schema.oneOf ?? schema.anyOf;
  if (options?.length && options.every(o => o.const !== undefined)) return options.map(o => o.const);
  return undefined;
}

export type FieldKind =
  | "file"
  | "datasetVersion"
  | "attribute"
  | "attributeList"
  | "code"
  | "enum"
  | "enumList"
  | "boolean"
  | "integer"
  | "number"
  | "text"
  | "textarea"
  | "password"
  | "objectList"
  | "stringList"
  | "object"
  | "json";

const CODE_DESCRIPTION = "input your code here";

export function fieldKind(key: string, raw: JsonSchema, root: JsonSchema): FieldKind {
  const schema = resolve(raw, root);
  if (key === "fileName") return "file";
  if (key === "datasetVersionPath") return "datasetVersion";
  if (schema.autofill === "attributeName") return "attribute";
  if (schema.autofill === "attributeNameList") return "attributeList";
  if (schema.description?.trim().toLowerCase() === CODE_DESCRIPTION) return "code";
  if (choices(schema)) return "enum";
  const formly = schema.widget?.formlyConfig;
  switch (primaryType(schema)) {
    case "boolean":
      return "boolean";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "string":
      if (formly?.type === "textarea") return "textarea";
      if (formly?.templateOptions?.type === "password" || formly?.props?.type === "password") return "password";
      return "text";
    case "array": {
      const items = resolve(schema.items ?? {}, root);
      if (items.autofill === "attributeName") return "attributeList";
      if (choices(items)) return "enumList";
      if (primaryType(items) === "object" || items.properties) return "objectList";
      if (primaryType(items) === "string") return "stringList";
      return "json";
    }
    case "object":
      return schema.properties ? "object" : "json";
    default:
      return schema.properties ? "object" : "json";
  }
}

// Properties every operator schema carries that no user edits.
const NEVER_SHOWN = new Set(["dummyPropertyList", "dummyOperator", "dummyProperty", "dummyValue"]);

/** An object schema's properties in display order (`propertyOrder`, then declaration order). */
export function orderedProperties(schema: JsonSchema): [string, JsonSchema][] {
  return Object.entries(schema.properties ?? {})
    .filter(([key, prop]) => !NEVER_SHOWN.has(key) && !prop.options?.hidden)
    .map((entry, index) => ({ entry, index, order: entry[1].propertyOrder ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(x => x.entry);
}

/**
 * Whether a field is hidden by the value of a sibling: `hideTarget` with `hideOnNull`,
 * `hideType: "regex"` (whole-string match) or `"equals"`, or a boolean sibling's
 * `toggleHidden` list while that boolean is off.
 */
export function isHidden(
  key: string,
  raw: JsonSchema,
  root: JsonSchema,
  values: Record<string, unknown>,
  siblings: Record<string, JsonSchema>
): boolean {
  const schema = resolve(raw, root);
  if (schema.hideTarget) {
    const target = values[schema.hideTarget];
    if (target === null || target === undefined) {
      if (schema.hideOnNull) return true;
    } else if (schema.hideExpectedValue !== undefined) {
      const expected = schema.hideExpectedValue;
      if (schema.hideType === "regex") {
        try {
          if (new RegExp(`^(${expected})$`).test(String(target))) return true;
        } catch {
          // An invalid pattern hides nothing.
        }
      } else if (String(target) === expected) return true;
    }
  }
  for (const [sibling, prop] of Object.entries(siblings)) {
    if (resolve(prop, root).toggleHidden?.includes(key) && !values[sibling]) return true;
  }
  return false;
}

/**
 * Starting values for an object schema: each field's default, and for a required
 * choice without one, its first option.
 */
export function initialValues(objectSchema: JsonSchema, root: JsonSchema): Record<string, unknown> {
  const schema = resolve(objectSchema, root);
  const required = new Set(schema.required ?? []);
  const values: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const p = resolve(prop, root);
    if (p.default !== undefined) values[key] = structuredClone(p.default);
    else if (required.has(key) && choices(p)?.length) values[key] = choices(p)?.[0];
  }
  return values;
}

/** A new item for an array of objects. */
export const newItem = (items: JsonSchema, root: JsonSchema) => initialValues(items, root);

/** Sets or removes a key: optional fields left empty are removed rather than saved as "". */
export function setValue(
  values: Record<string, unknown>,
  key: string,
  value: unknown,
  required: boolean
): Record<string, unknown> {
  const next = { ...values };
  const empty = value === undefined || value === null || (value === "" && !required);
  if (empty && !required) delete next[key];
  else next[key] = value;
  return next;
}
