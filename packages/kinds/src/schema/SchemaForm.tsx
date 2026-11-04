// A form over a JSON Schema: the generic spec editor of every kind. Strings, numbers,
// booleans, enums, lists of strings, string maps and nested objects get controls; anything
// richer is edited as JSON. Kinds with their own forms replace this, never extend it.

import { Button, Chip, Field, Input, NativeSelect, Textarea, cn } from "@texera/ui";
import type { JsonSchema } from "@texera/workflow-model";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { deref, fieldType, properties } from "./schema";

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** Property names rendered as multi-line text. */
  long?: readonly string[];
  /** Property names left out. */
  hidden?: readonly string[];
  disabled?: boolean;
  className?: string;
}

const title = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, c => c.toUpperCase())
    .replace(/\b(Url|Uri|Id)\b/g, s => s.toUpperCase());

export function SchemaForm({ schema, value, onChange, long = [], hidden = [], disabled = false, className }: SchemaFormProps) {
  const s = deref(schema);
  const required = new Set(s.required ?? []);
  const fields = properties(s).filter(([key]) => !hidden.includes(key));
  if (fields.length === 0) return <p className="text-xs text-muted-foreground">Nothing to set.</p>;
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className={cn("space-y-4", className)} data-schema-form>
      {fields.map(([key, prop]) => (
        <SchemaField
          key={key}
          name={key}
          schema={prop}
          value={value[key]}
          required={required.has(key)}
          long={long}
          hidden={hidden}
          disabled={disabled}
          onChange={v => set(key, v)}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  value,
  required,
  long,
  hidden,
  disabled,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  long: readonly string[];
  hidden: readonly string[];
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const s = deref(schema);
  const label = s.title ?? title(name);
  const type = fieldType(s);
  const help = s.description;
  switch (type) {
    case "string":
      return (
        <Field label={label} help={help} required={required} htmlFor={id}>
          {long.includes(name) ? (
            <Textarea
              id={id}
              value={typeof value === "string" ? value : ""}
              rows={name === "code" || name === "body" || name === "prompt" ? 12 : 4}
              className={cn("text-xs", (name === "code" || name === "body" || name === "prompt") && "font-mono")}
              disabled={disabled}
              spellCheck={false}
              onChange={e => onChange(e.target.value || undefined)}
              data-field={name}
            />
          ) : (
            <Input id={id} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={e => onChange(e.target.value || undefined)} data-field={name} />
          )}
        </Field>
      );
    case "enum":
      return (
        <Field label={label} help={help} required={required} htmlFor={id}>
          <NativeSelect id={id} value={value === undefined ? "" : String(value)} disabled={disabled} onChange={e => onChange(e.target.value || undefined)} className="w-full" data-field={name}>
            {!required && <option value="">—</option>}
            {(s.enum ?? []).map(option => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      );
    case "number":
      return (
        <Field label={label} help={help} required={required} htmlFor={id}>
          <Input
            id={id}
            type="number"
            value={typeof value === "number" ? value : ""}
            min={s.minimum}
            max={s.maximum}
            step={s.type === "integer" ? 1 : "any"}
            disabled={disabled}
            onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
            data-field={name}
          />
        </Field>
      );
    case "boolean":
      return (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={value === true} disabled={disabled} onChange={e => onChange(e.target.checked ? true : required ? false : undefined)} data-field={name} />
          <span>
            <span className="block text-xs font-medium">{label}</span>
            {help && <span className="block text-2xs text-muted-foreground">{help}</span>}
          </span>
        </label>
      );
    case "strings":
      return (
        <Field label={label} help={help} required={required}>
          <StringList value={Array.isArray(value) ? value.map(String) : []} disabled={disabled} onChange={v => onChange(v.length ? v : required ? [] : undefined)} name={name} />
        </Field>
      );
    case "map":
      return (
        <Field label={label} help={help} required={required}>
          <KeyValueList value={isStringMap(value) ? value : {}} disabled={disabled} onChange={v => onChange(Object.keys(v).length ? v : undefined)} name={name} />
        </Field>
      );
    case "object":
      return (
        <fieldset className="space-y-3 rounded-lg border p-3" data-field={name}>
          <legend className="px-1 text-xs font-medium">{label}</legend>
          {help && <p className="text-2xs text-muted-foreground">{help}</p>}
          <SchemaForm schema={s} value={isRecord(value) ? value : {}} long={long} hidden={hidden} disabled={disabled} onChange={v => onChange(Object.keys(v).length ? v : undefined)} />
        </fieldset>
      );
    default:
      return (
        <Field label={`${label} (JSON)`} help={help} required={required} htmlFor={id}>
          <JsonText id={id} value={value} disabled={disabled} onChange={onChange} name={name} />
        </Field>
      );
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every(x => typeof x === "string");

export function StringList({ value, onChange, disabled, name }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; name?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-field={name}>
      {value.map(item => (
        <Chip key={item} onRemove={disabled ? undefined : () => onChange(value.filter(x => x !== item))}>
          {item}
        </Chip>
      ))}
      {!disabled && (
        <Input
          value={draft}
          placeholder="Add…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          className="h-7 w-44 text-xs"
          aria-label={`Add to ${name ?? "list"}`}
        />
      )}
    </div>
  );
}

export function KeyValueList({ value, onChange, disabled, name }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled?: boolean; name?: string }) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
  const commit = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim())));
  };
  return (
    <div className="space-y-1.5" data-field={name}>
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div key={i} className="flex gap-1.5">
          <Input value={k} placeholder="name" disabled={disabled} className="h-8 text-xs" onChange={e => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} aria-label="Key" />
          <Input value={v} placeholder="value" disabled={disabled} className="h-8 text-xs" onChange={e => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} aria-label="Value" />
          {!disabled && (
            <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => commit(rows.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <Button variant="outline" size="xs" onClick={() => setRows([...rows, ["", ""]])}>
          <Plus /> Add
        </Button>
      )}
    </div>
  );
}

function JsonText({ id, value, onChange, disabled, name }: { id: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; name?: string }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string>();
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        value={text}
        rows={6}
        className={cn("font-mono text-xs", error && "border-destructive")}
        spellCheck={false}
        disabled={disabled}
        data-field={name}
        onChange={e => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setError(undefined);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setError(undefined);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}
