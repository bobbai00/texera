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

import { PlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ParameterType, parameterTypes, type UdfParameter } from "@/lib/workflow/udf-parameters";
import type { TextControl } from "./property-form";

export interface UdfParametersProps {
  parameters: UdfParameter[];
  /** Why the parameters could not be read from the code, if they could not. */
  problem?: string;
  /** The control that picks a version of a dataset, from the dataset feature. */
  datasetVersion?: TextControl;
  disabled?: boolean;
  onChange: (parameters: UdfParameter[]) => void;
  /** Declares one more parameter in the code, and says what kept it from doing so, if anything did. */
  onAdd: (name: string, type: ParameterType) => string | undefined;
}

/** What each type of value is given with. Every value is kept as text, which the engine reads as its type. */
const inputs: Partial<Record<ParameterType, { type: string; step?: string; placeholder?: string }>> = {
  integer: { type: "number", step: "1" },
  long: { type: "number", step: "1" },
  double: { type: "number", step: "any" },
  timestamp: { type: "text", placeholder: "2026-11-18 10:00:00" },
};

/**
 * The values of the parameters a UDF's code declares. Which parameters there are is the code's to say: one is
 * added by declaring it there, which this does too.
 */
export function UdfParameters({
  parameters,
  problem,
  datasetVersion: DatasetVersion,
  disabled,
  onChange,
  onAdd,
}: UdfParametersProps) {
  const setValue = (index: number, value: string) =>
    onChange(parameters.map((parameter, at) => (at === index ? { ...parameter, value } : parameter)));

  return (
    <section
      aria-label="Parameters"
      className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Parameters</h3>
        <p className="text-sm text-muted-foreground">
          The code declares each with <code className="font-mono text-xs">self.UiParameter(name, type)</code>.
        </p>
      </div>
      <ErrorAlert error={problem} />
      {parameters.map((parameter, index) => (
        <ParameterField
          key={`${parameter.attribute.attributeName}:${parameter.inputType ?? ""}`}
          parameter={parameter}
          datasetVersion={DatasetVersion}
          disabled={disabled}
          onChange={value => setValue(index, value)}
        />
      ))}
      {!disabled && <AddParameter onAdd={onAdd} />}
    </section>
  );
}

function ParameterField({
  parameter,
  datasetVersion: DatasetVersion,
  disabled,
  onChange,
}: {
  parameter: UdfParameter;
  datasetVersion?: TextControl;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const { attribute, value, inputType } = parameter;
  const kind = inputType ?? attribute.attributeType;
  const label = (
    <FieldLabel htmlFor={id}>
      {attribute.attributeName} <span className="font-normal text-muted-foreground">{kind}</span>
    </FieldLabel>
  );

  if (attribute.attributeType === "boolean") {
    return (
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={value === "true"}
          disabled={disabled}
          onCheckedChange={checked => onChange(checked === true ? "true" : "false")}
        />
        {label}
      </Field>
    );
  }
  if (inputType === "dataset" && DatasetVersion) {
    return (
      <Field>
        {label}
        <DatasetVersion
          id={id}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      </Field>
    );
  }
  const input = inputs[attribute.attributeType];
  return (
    <Field>
      {label}
      <Input
        id={id}
        value={value}
        disabled={disabled}
        type={input?.type ?? "text"}
        step={input?.step}
        placeholder={inputType === "model" ? "/model/owner/name/version" : input?.placeholder}
        onChange={event => onChange(event.target.value)}
      />
      {inputType === "model" && <FieldDescription>The path of a version of a model.</FieldDescription>}
    </Field>
  );
}

function AddParameter({ onAdd }: { onAdd: UdfParametersProps["onAdd"] }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<ParameterType>("string");
  const [problem, setProblem] = useState<string>();
  const nameId = useId();

  if (!adding) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setAdding(true)}>
        <PlusIcon />
        Add a parameter
      </Button>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const refused = onAdd(typeof name === "string" ? name : "", type);
    setProblem(refused);
    if (!refused) setAdding(false);
  }

  return (
    <form
      aria-label="New parameter"
      className="space-y-2 rounded-lg border p-3"
      onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          name="name"
          // The field is there to be typed in at once.
          autoFocus
        />
      </Field>
      <Field>
        <FieldLabel>Type</FieldLabel>
        <Select
          value={type}
          onValueChange={value => setType(value as ParameterType)}>
          <SelectTrigger aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {parameterTypes.map(each => (
              <SelectItem
                key={each}
                value={each}>
                {each}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ErrorAlert error={problem} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAdding(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm">
          Declare it in the code
        </Button>
      </div>
    </form>
  );
}
