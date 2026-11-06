import type { Attribute } from "@texera/catalog-client/types";
import { Button, Chip, cn, DialogContent, DialogRoot, Input, NativeSelect, Textarea } from "@texera/ui";
import {
  choices,
  fieldKind,
  isHidden,
  type JsonSchema,
  newItem,
  orderedProperties,
  primaryType,
  resolve,
  setValue,
} from "@texera/workflow-model";
import { Maximize2, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { CredentialPicker } from "./CredentialPicker";
import { DatasetFilePicker } from "./DatasetFilePicker";

/** What every field needs: the operator's root schema (for $refs) and its input columns per port. */
interface FormContext {
  root: JsonSchema;
  inputs: (Attribute[] | undefined)[];
  disabled: boolean;
}

/**
 * An operator's settings, generated from the JSON Schema the engine publishes for it.
 * Column fields list the columns of the operator's input, as the compiler reports them.
 */
export function PropertyForm({
  schema,
  values,
  onChange,
  inputs,
  disabled = false,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  inputs: (Attribute[] | undefined)[];
  disabled?: boolean;
}) {
  return <ObjectFields schema={schema} values={values} onChange={onChange} ctx={{ root: schema, inputs, disabled }} />;
}

function ObjectFields({
  schema,
  values,
  onChange,
  ctx,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  ctx: FormContext;
}) {
  const resolved = resolve(schema, ctx.root);
  const siblings = resolved.properties ?? {};
  const required = new Set(resolved.required ?? []);
  const fields = orderedProperties(resolved).filter(([key, prop]) => !isHidden(key, prop, ctx.root, values, siblings));
  if (fields.length === 0) return <p className="text-xs text-muted-foreground">This operator has no settings.</p>;
  return (
    <div className="space-y-3">
      {fields.map(([key, prop]) => (
        <Field
          key={key}
          name={key}
          schema={prop}
          value={values[key]}
          required={required.has(key)}
          onChange={v => onChange(setValue(values, key, v, required.has(key)))}
          ctx={ctx}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  schema: raw,
  value,
  required,
  onChange,
  ctx,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
  ctx: FormContext;
}) {
  const id = useId();
  const schema = resolve(raw, ctx.root);
  const kind = fieldKind(name, raw, ctx.root);
  const label = schema.title?.trim() || name;
  const missing =
    required && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0));
  const help = kind === "code" ? undefined : schema.description;
  const columns = ctx.inputs[schema.autofillAttributeOnPort ?? 0] ?? (kind === "attributeList" ? ctx.inputs[0] : undefined);

  const input = (() => {
    switch (kind) {
      case "boolean":
        return (
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value ?? schema.default)}
            disabled={ctx.disabled}
            onChange={e => onChange(e.target.checked)}
            className="size-4 accent-primary"
          />
        );
      case "integer":
      case "number":
        return (
          <Input
            id={id}
            type="number"
            step={kind === "integer" ? 1 : "any"}
            value={value === undefined || value === null ? "" : String(value)}
            placeholder={schema.default !== undefined ? String(schema.default) : undefined}
            disabled={ctx.disabled}
            onChange={e => {
              const text = e.target.value;
              onChange(text === "" ? undefined : kind === "integer" ? Math.trunc(Number(text)) : Number(text));
            }}
            className="h-8 text-xs"
          />
        );
      case "enum":
        return (
          <NativeSelect
            id={id}
            value={value === undefined || value === null ? "" : String(value)}
            disabled={ctx.disabled}
            onChange={e => onChange((choices(schema) ?? []).find(c => String(c) === e.target.value))}
            className="w-full">
            {(!required || value === undefined) && <option value="">{required ? "Choose…" : "None"}</option>}
            {(choices(schema) ?? []).map(c => (
              <option key={String(c)} value={String(c)}>
                {String(c)}
              </option>
            ))}
          </NativeSelect>
        );
      case "attribute":
        return (
          <ColumnPicker
            id={id}
            value={value}
            columns={columns}
            extra={schema.additionalEnumValue ?? (!required && typeof schema.default === "string" ? schema.default : undefined)}
            onChange={onChange}
            disabled={ctx.disabled}
          />
        );
      case "attributeList":
        return <ColumnsPicker value={value} columns={columns} onChange={onChange} disabled={ctx.disabled} />;
      case "enumList":
        return (
          <ChipToggle
            options={(choices(resolve(schema.items ?? {}, ctx.root)) ?? []).map(String)}
            value={Array.isArray(value) ? value.map(String) : []}
            onChange={onChange}
            disabled={ctx.disabled}
          />
        );
      case "code":
        return (
          <CodeField
            id={id}
            value={typeof value === "string" ? value : String(schema.default ?? "")}
            onChange={onChange}
            disabled={ctx.disabled}
          />
        );
      case "textarea":
        return (
          <Textarea
            id={id}
            value={typeof value === "string" ? value : ""}
            disabled={ctx.disabled}
            onChange={e => onChange(e.target.value)}
            className="text-xs"
          />
        );
      case "credential":
        return <CredentialPicker id={id} value={typeof value === "string" ? value : ""} onChange={onChange} disabled={ctx.disabled} />;
      case "file":
      case "datasetVersion":
        return (
          <DatasetFilePicker
            id={id}
            value={typeof value === "string" ? value : ""}
            mode={kind === "file" ? "file" : "version"}
            onChange={onChange}
            disabled={ctx.disabled}
          />
        );
      case "objectList":
        return <ObjectList schema={schema} value={value} onChange={onChange} ctx={ctx} />;
      case "stringList":
        return <StringList value={value} onChange={onChange} disabled={ctx.disabled} />;
      case "object":
        return (
          <div className="rounded-lg border p-2.5">
            <ObjectFields schema={schema} values={(value as Record<string, unknown>) ?? {}} onChange={onChange} ctx={ctx} />
          </div>
        );
      case "json":
        return <JsonField id={id} value={value} onChange={onChange} disabled={ctx.disabled} />;
      default:
        return (
          <Input
            id={id}
            type={kind === "password" ? "password" : "text"}
            value={typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)}
            placeholder={schema.default !== undefined ? String(schema.default) : undefined}
            maxLength={schema.maxLength}
            disabled={ctx.disabled}
            onChange={e => onChange(e.target.value)}
            className="h-8 text-xs"
          />
        );
    }
  })();

  if (kind === "boolean") {
    return (
      <label htmlFor={id} className="flex items-start gap-2" data-property={name}>
        {input}
        <span className="space-y-0.5">
          <span className="block text-xs font-medium">{label}</span>
          {help && <span className="block text-2xs text-muted-foreground">{help}</span>}
        </span>
      </label>
    );
  }
  return (
    <div className="space-y-1" data-property={name}>
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {input}
      {help && <p className="text-2xs text-muted-foreground">{help}</p>}
      {missing && !ctx.disabled && <p className="text-2xs text-destructive">Required</p>}
    </div>
  );
}

function ColumnPicker({
  id,
  value,
  columns,
  extra,
  onChange,
  disabled,
}: {
  id: string;
  value: unknown;
  columns: Attribute[] | undefined;
  extra?: string;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const current = typeof value === "string" ? value : "";
  if (!columns) {
    return (
      <Input
        id={id}
        value={current}
        placeholder="Column name (link an input to pick from its columns)"
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="h-8 text-xs"
      />
    );
  }
  const names = columns.map(c => c.attributeName);
  return (
    <NativeSelect id={id} value={current} disabled={disabled} onChange={e => onChange(e.target.value)} className="w-full">
      <option value="">Choose a column…</option>
      {current && !names.includes(current) && current !== extra && <option value={current}>{current} (not in the input)</option>}
      {columns.map(c => (
        <option key={c.attributeName} value={c.attributeName}>
          {c.attributeName} · {c.attributeType}
        </option>
      ))}
      {extra && <option value={extra}>{extra}</option>}
    </NativeSelect>
  );
}

function ColumnsPicker({
  value,
  columns,
  onChange,
  disabled,
}: {
  value: unknown;
  columns: Attribute[] | undefined;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  if (!columns) return <StringList value={value} onChange={onChange} disabled={disabled} placeholder="Column name" />;
  return <ChipToggle options={columns.map(c => c.attributeName)} value={selected} onChange={onChange} disabled={disabled} />;
}

function ChipToggle({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string[];
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  if (options.length === 0) return <p className="text-2xs text-muted-foreground">No options.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter(v => v !== o) : [...value, o])}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs",
              on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent"
            )}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

function StringList({
  value,
  onChange,
  disabled,
  placeholder = "Add a value",
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const items = Array.isArray(value) ? value.map(String) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...items, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: values may repeat; position identifies a chip
            <Chip key={`${item}-${i}`} onRemove={disabled ? undefined : () => onChange(items.filter((_, j) => j !== i))}>
              {item}
            </Chip>
          ))}
        </div>
      )}
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        className="h-8 text-xs"
      />
    </div>
  );
}

function ObjectList({
  schema,
  value,
  onChange,
  ctx,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: FormContext;
}) {
  const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const itemSchema = schema.items ?? {};
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
        <div key={i} className="relative rounded-lg border bg-muted/20 p-2.5 pr-9">
          <ObjectFields
            schema={itemSchema}
            values={item ?? {}}
            onChange={next => onChange(items.map((it, j) => (j === i ? next : it)))}
            ctx={ctx}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-1 right-1"
            disabled={ctx.disabled}
            aria-label="Remove row"
            onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="xs" disabled={ctx.disabled} onClick={() => onChange([...items, newItem(itemSchema, ctx.root)])}>
        <Plus /> Add {primaryType(resolve(itemSchema, ctx.root)) === "object" ? "row" : "item"}
      </Button>
    </div>
  );
}

function JsonField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <Textarea
        id={id}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) return onChange(undefined);
          try {
            onChange(JSON.parse(text));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
        className="font-mono text-2xs"
      />
      {bad && <p className="text-2xs text-destructive">Not valid JSON.</p>}
    </>
  );
}

/**
 * Code, edited in a card: a few lines where the card is, and the whole of it in a larger
 * editor, so a long script does not make the card cover the canvas.
 */
function CodeField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const code = (className: string, props: { id?: string; "aria-label"?: string }) => (
    <Textarea
      {...props}
      value={value}
      disabled={disabled}
      spellCheck={false}
      onChange={e => onChange(e.target.value)}
      className={cn("bg-muted/30 font-mono text-2xs leading-relaxed", className)}
    />
  );
  return (
    <div className="space-y-1.5">
      {code("h-28", { id })}
      <Button variant="outline" size="xs" onClick={() => setOpen(true)} data-code-open>
        <Maximize2 /> Open larger
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent title="Code" className="max-w-4xl">
          {code("h-[60vh]", { "aria-label": "Code" })}
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
