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

import { PlusIcon, XIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Attribute } from "@/lib/workflow/compilation";
import { type DelimiterMode, delimiterPresets, delimiterProblem } from "@/lib/workflow/delimiter";
import type { JsonSchema } from "@/lib/workflow/operator-schema";
import {
  columnChoices,
  columnTypeWarnings,
  delimiterMode,
  extraChoice,
  fieldKind,
  fieldLabel,
  type PropertyField,
  resolve,
  visibleFields,
} from "@/lib/workflow/property-schema";

type Values = Record<string, unknown>;

/** A control that edits a property whose value is a text, and is found rather than typed. */
export type TextControl = ComponentType<{
  /** The id that the field's label points to. */
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}>;

/**
 * The controls that come from another feature, by the kind of field each edits. A field whose control is not
 * given is edited as text.
 */
export interface PropertyControls {
  /** Picks a file of a dataset. */
  datasetFile?: TextControl;
  /** Picks a version of a dataset. */
  datasetVersion?: TextControl;
}

export interface PropertyFormProps {
  /** The JSON schema of the operator type's properties. */
  schema: JsonSchema;
  values: Values;
  /** The columns that arrive at each input port of the operator, for the fields that name a column. */
  inputSchemas: (Attribute[] | undefined)[];
  /** Properties that are edited somewhere else, such as an operator's code. */
  omit?: readonly string[];
  controls?: PropertyControls;
  disabled?: boolean;
  /** A property was given a value, or cleared: then the value is undefined. */
  onChange: (key: string, value: unknown) => void;
}

/** What every field of the form needs besides its own schema and value. */
interface FormContext {
  root: JsonSchema;
  inputSchemas: (Attribute[] | undefined)[];
  controls: PropertyControls;
  disabled: boolean;
}

const noControls: PropertyControls = {};

/** The form of an operator's properties, drawn from the operator type's schema. Every change is reported at once. */
export function PropertyForm({
  schema,
  values,
  inputSchemas,
  omit,
  controls = noControls,
  disabled = false,
  onChange,
}: PropertyFormProps) {
  return (
    <ObjectFields
      schema={schema}
      values={values}
      omit={omit}
      context={{ root: schema, inputSchemas, controls, disabled }}
      onChange={onChange}
    />
  );
}

/** The values with one of them changed. One that is cleared is left out: the engine reads a missing one as not set. */
function withValue(values: Values, key: string, value: unknown): Values {
  const changed = { ...values, [key]: value };
  if (value === undefined) delete changed[key];
  return changed;
}

/** The fields of an object: an operator's properties, or one row of a list. */
function ObjectFields({
  schema,
  values,
  omit = [],
  context,
  onChange,
}: {
  schema: JsonSchema;
  values: Values;
  omit?: readonly string[];
  context: FormContext;
  onChange: (key: string, value: unknown) => void;
}) {
  const warnings = columnTypeWarnings(schema, values, context.inputSchemas);
  return (
    <FieldGroup>
      {visibleFields(schema, context.root, values)
        .filter(field => !omit.includes(field.key))
        .map(field => (
          <PropertyControl
            key={field.key}
            field={field}
            value={values[field.key]}
            warning={warnings[field.key]}
            context={context}
            onChange={value => onChange(field.key, value)}
          />
        ))}
    </FieldGroup>
  );
}

interface ControlProps {
  field: PropertyField;
  value: unknown;
  /** What is unexpected about the value, though the operator may still be executed with it. */
  warning?: string;
  context: FormContext;
  onChange: (value: unknown) => void;
}

/** One field: its label, the control that fits its schema, and what the backend says about it. */
function PropertyControl({ field, value, warning, context, onChange }: ControlProps) {
  const id = useId();
  const { schema, required } = field;
  const { disabled, root } = context;
  const label = fieldLabel(field) + (required ? " *" : "");
  const kind = fieldKind(field);
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const description: ReactNode = (
    <>
      {schema.description && <FieldDescription>{schema.description}</FieldDescription>}
      {warning && (
        <FieldDescription
          role="note"
          className="text-warning">
          {warning}
        </FieldDescription>
      )}
    </>
  );
  // A text field that is emptied is cleared, unless the operator needs it: then it is empty text.
  const setText = (next: string) => onChange(next === "" && !required ? undefined : next);

  switch (kind) {
    case "switch":
      return (
        <Field orientation="horizontal">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={checked => onChange(checked === true)}
          />
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
        </Field>
      );
    case "rows":
      return (
        <Rows
          label={label}
          schema={resolve(schema.items ?? {}, root)}
          rows={Array.isArray(value) ? (value as Values[]) : []}
          context={context}
          onChange={onChange}
        />
      );
    case "group":
      return (
        <FieldSet>
          <FieldLegend variant="label">{label}</FieldLegend>
          <ObjectFields
            schema={schema}
            values={(value as Values | undefined) ?? {}}
            context={context}
            onChange={(key, changed) => onChange(withValue((value as Values | undefined) ?? {}, key, changed))}
          />
        </FieldSet>
      );
    case "columns":
    case "choices": {
      const columns = columnChoices(schema, context.inputSchemas)?.map(column => column.attributeName);
      const options = kind === "columns" ? columns : (schema.items?.enum as string[]);
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      if (!options) {
        return (
          <Field>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Input
              id={id}
              value={chosen.join(", ")}
              placeholder="Column names, separated by commas"
              disabled={disabled}
              onChange={event =>
                onChange(
                  event.target.value
                    .split(",")
                    .map(name => name.trim())
                    .filter(Boolean)
                )
              }
            />
            {description}
          </Field>
        );
      }
      return (
        <FieldSet>
          <FieldLegend variant="label">{label}</FieldLegend>
          {description}
          <Checkboxes
            options={options}
            chosen={chosen}
            disabled={disabled}
            onChange={onChange}
          />
        </FieldSet>
      );
    }
    case "choice":
    case "column": {
      const columns = columnChoices(schema, context.inputSchemas);
      // Without the input's columns a column is typed in, as it may be one the input will have.
      if (kind === "column" && !columns) break;
      const extra = extraChoice(schema);
      const options =
        kind === "column"
          ? [...columns!.map(column => column.attributeName), ...(extra ? [extra] : [])]
          : (schema.enum as unknown[]).map(String);
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Select
            value={text}
            disabled={disabled}
            onValueChange={onChange}>
            <SelectTrigger
              id={id}
              className="w-full">
              <SelectValue placeholder={kind === "column" ? "Choose a column" : "Choose"} />
            </SelectTrigger>
            <SelectContent position="popper">
              {/* A value that is no longer among the choices stays, so that it is seen and changed. */}
              {[...new Set(text && !options.includes(text) ? [text, ...options] : options)].map(option => (
                <SelectItem
                  key={option}
                  value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description}
        </Field>
      );
    }
    case "datasetFile":
    case "datasetVersion": {
      const Control = context.controls[kind];
      // Without the control, the path is typed like any text.
      if (!Control) break;
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Control
            id={id}
            value={text}
            disabled={disabled}
            onChange={setText}
          />
          {description}
        </Field>
      );
    }
    case "delimiter":
      return (
        <DelimiterField
          id={id}
          label={label}
          value={text}
          mode={delimiterMode(schema)}
          disabled={disabled}
          onChange={setText}>
          {description}
        </DelimiterField>
      );
    case "texts":
      return (
        <Texts
          label={label}
          texts={Array.isArray(value) ? (value as string[]) : []}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "unknown":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <FieldDescription>This property cannot be edited here yet.</FieldDescription>
        </Field>
      );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {kind === "longText" ? (
        <Textarea
          id={id}
          value={text}
          disabled={disabled}
          onChange={event => setText(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={kind === "number" ? "number" : kind === "password" ? "password" : "text"}
          value={text}
          placeholder={kind === "column" ? "Column name" : undefined}
          disabled={disabled}
          onChange={event =>
            kind === "number"
              ? onChange(event.target.value === "" ? undefined : Number(event.target.value))
              : setText(event.target.value)
          }
        />
      )}
      {description}
    </Field>
  );
}

/** A list of rows, each a small form of its own, such as the predicates of a filter. */
function Rows({
  label,
  schema,
  rows,
  context,
  onChange,
}: {
  label: string;
  schema: JsonSchema;
  rows: Values[];
  context: FormContext;
  onChange: (rows: Values[]) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <ol
        aria-label={label}
        className="space-y-2">
        {rows.map((row, index) => (
          // Rows have no identity of their own: a row is the values at its place.
          <li
            key={index}
            className="relative rounded-lg border p-3 pr-10">
            <ObjectFields
              schema={schema}
              values={row}
              context={context}
              onChange={(key, value) => onChange(rows.with(index, withValue(row, key, value)))}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-1.5 right-1.5"
              aria-label={`Remove row ${index + 1} of ${label}`}
              disabled={context.disabled}
              onClick={() => onChange(rows.toSpliced(index, 1))}>
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={context.disabled}
        onClick={() => onChange([...rows, {}])}>
        <PlusIcon />
        Add
      </Button>
    </FieldSet>
  );
}

const typed = "typed";

/** What separates values: one of the usual ones by name, or another that is typed. */
function DelimiterField({
  id,
  label,
  value,
  mode,
  disabled,
  children,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  mode: DelimiterMode;
  disabled: boolean;
  children: ReactNode;
  onChange: (value: string) => void;
}) {
  const presets = delimiterPresets[mode];
  const preset = presets.findIndex(each => each.value === value);
  // Once "another" is chosen it stays chosen, also while what is typed is what a named one holds.
  const [typing, setTyping] = useState(value !== "" && preset < 0);
  const problem = delimiterProblem(value, mode);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={typing ? typed : preset < 0 ? "" : String(preset)}
        disabled={disabled}
        onValueChange={choice => {
          setTyping(choice === typed);
          if (choice !== typed) onChange(presets[Number(choice)].value);
        }}>
        <SelectTrigger
          id={id}
          className="w-full">
          <SelectValue placeholder="Choose a delimiter" />
        </SelectTrigger>
        <SelectContent position="popper">
          {presets.map((each, index) => (
            <SelectItem
              key={each.label}
              value={String(index)}>
              {each.label}
            </SelectItem>
          ))}
          <SelectItem value={typed}>{mode === "regex" ? "Another expression…" : "Another character…"}</SelectItem>
        </SelectContent>
      </Select>
      {typing && (
        <Input
          aria-label={`${label}, typed`}
          value={value}
          placeholder={mode === "regex" ? "A regular expression, such as [,;]" : "A single character"}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        />
      )}
      {problem && <FieldError>{problem}</FieldError>}
      {children}
    </Field>
  );
}

/** A list of texts, one to a line, such as the corners of a bounding box. */
function Texts({
  label,
  texts,
  disabled,
  onChange,
}: {
  label: string;
  texts: string[];
  disabled: boolean;
  onChange: (texts: string[]) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <ol
        aria-label={label}
        className="space-y-2">
        {texts.map((text, index) => (
          <li
            key={index}
            className="flex gap-2">
            <Input
              aria-label={`${label}, ${index + 1}`}
              value={text}
              disabled={disabled}
              onChange={event => onChange(texts.with(index, event.target.value))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${index + 1} of ${label}`}
              disabled={disabled}
              onClick={() => onChange(texts.toSpliced(index, 1))}>
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange([...texts, ""])}>
        <PlusIcon />
        Add
      </Button>
    </FieldSet>
  );
}

/** Several of a set of options, each with a tick box. */
function Checkboxes({
  options,
  chosen,
  disabled,
  onChange,
}: {
  options: string[];
  chosen: string[];
  disabled: boolean;
  onChange: (chosen: string[]) => void;
}) {
  const id = useId();
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3">
      {options.map(option => (
        <Field
          key={option}
          orientation="horizontal">
          <Checkbox
            id={`${id}-${option}`}
            checked={chosen.includes(option)}
            disabled={disabled}
            onCheckedChange={checked =>
              onChange(checked === true ? [...chosen, option] : chosen.filter(other => other !== option))
            }
          />
          <FieldLabel
            htmlFor={`${id}-${option}`}
            className="font-normal">
            {option}
          </FieldLabel>
        </Field>
      ))}
    </div>
  );
}
