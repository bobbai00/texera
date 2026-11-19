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

import { CodeIcon } from "lucide-react";
import { useId } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { codeLanguage, codeLanguageNames, codeProperty } from "@/lib/workflow/code";
import { type ParameterType, type UdfParameter, udfParametersProperty } from "@/lib/workflow/udf-parameters";
import type { Attribute } from "@/lib/workflow/compilation";
import type { OperatorPatch } from "@/lib/workflow/document";
import type { Operator } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";
import { type PropertyControls, PropertyForm } from "./property-form";
import { UdfParameters } from "./udf-parameters";

export interface PropertyPanelProps {
  operator: Operator;
  schema: OperatorSchema;
  /** The columns that arrive at each input port of the operator. */
  inputSchemas: (Attribute[] | undefined)[];
  /** Why the operator cannot be executed as it is. */
  problem?: string;
  /** The controls that come from another feature, such as the one that picks a file of a dataset. */
  controls?: PropertyControls;
  disabled?: boolean;
  onPatch: (patch: OperatorPatch) => void;
  /** A property was given a value, or cleared: then the value is undefined. */
  onProperty: (key: string, value: unknown) => void;
  /** The user asks for the operator's code, which is read and written in an editor of its own. Without it, the
   * code is not offered. */
  onOpenCode?: () => void;
  /** Why the parameters its code declares cannot be read, for an operator whose code declares them. */
  parametersProblem?: string;
  /** Declares one more parameter in the operator's code, and says what kept it from doing so, if anything did. */
  onAddParameter?: (name: string, type: ParameterType) => string | undefined;
}

/** Everything about the one operator that is selected: its name, its switches, and its properties. */
export function PropertyPanel({
  operator,
  schema,
  inputSchemas,
  problem,
  controls,
  disabled,
  onPatch,
  onProperty,
  onOpenCode,
  parametersProblem,
  onAddParameter,
}: PropertyPanelProps) {
  const nameId = useId();
  const disabledId = useId();
  const viewResultId = useId();
  const { userFriendlyName, operatorDescription } = schema.additionalMetadata;
  const language = codeLanguage(operator.operatorType);
  const declaresParameters = udfParametersProperty in (schema.jsonSchema.properties ?? {});

  return (
    <section
      aria-label={`Properties of ${operator.customDisplayName}`}
      className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="font-medium">{userFriendlyName}</h2>
        {operatorDescription && <p className="text-sm text-muted-foreground">{operatorDescription}</p>}
      </div>
      <ErrorAlert error={problem} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            value={operator.customDisplayName ?? ""}
            disabled={disabled}
            onChange={event => onPatch({ customDisplayName: event.target.value })}
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={viewResultId}
            checked={operator.viewResult === true}
            disabled={disabled}
            onCheckedChange={checked => onPatch({ viewResult: checked === true })}
          />
          <FieldLabel htmlFor={viewResultId}>Keep its result for viewing</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={disabledId}
            checked={operator.isDisabled === true}
            disabled={disabled}
            onCheckedChange={checked => onPatch({ isDisabled: checked === true })}
          />
          <FieldLabel htmlFor={disabledId}>Leave it out of executions</FieldLabel>
        </Field>
      </FieldGroup>
      <Separator />
      {language && onOpenCode && (
        <Button
          variant="outline"
          className="w-full"
          onClick={onOpenCode}>
          <CodeIcon />
          {disabled ? "View" : "Edit"} the {codeLanguageNames[language]} code
        </Button>
      )}
      {declaresParameters && (
        <UdfParameters
          parameters={(operator.operatorProperties[udfParametersProperty] ?? []) as UdfParameter[]}
          problem={parametersProblem}
          datasetVersion={controls?.datasetVersion}
          disabled={disabled}
          onChange={parameters => onProperty(udfParametersProperty, parameters)}
          onAdd={(name, type) => onAddParameter?.(name, type) ?? "The code cannot be changed here."}
        />
      )}
      <PropertyForm
        schema={schema.jsonSchema}
        values={operator.operatorProperties}
        inputSchemas={inputSchemas}
        // The code and the parameters it declares each have a place of their own, beside the form.
        omit={[...(language ? [codeProperty] : []), ...(declaresParameters ? [udfParametersProperty] : [])]}
        controls={controls}
        disabled={disabled}
        onChange={onProperty}
      />
    </section>
  );
}
