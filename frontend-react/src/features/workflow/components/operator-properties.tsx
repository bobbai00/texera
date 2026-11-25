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
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import { codeLanguage, codeLanguageNames, codeProperty } from "@/lib/workflow/code";
import type { Attribute } from "@/lib/workflow/compilation";
import type { Operator } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";
import { type ParameterType, type UdfParameter, udfParametersProperty } from "@/lib/workflow/udf-parameters";
import { type PropertyControls, PropertyForm } from "./property-form";
import { UdfParameters } from "./udf-parameters";

export interface OperatorPropertiesProps {
  operator: Operator;
  schema: OperatorSchema;
  /** The columns that arrive at each input port of the operator. */
  inputSchemas: (Attribute[] | undefined)[];
  /** Why the operator cannot be executed as it is. */
  problem?: string;
  /** The controls that come from another feature, such as the one that picks a file of a dataset. */
  controls?: PropertyControls;
  disabled?: boolean;
  /**
   * Whether the operator's code opens only to read; by default, as its other properties do. Code is shared text that
   * no one holds, so a card open only to read while someone else edits it still opens its code to type in.
   */
  codeReadOnly?: boolean;
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

/**
 * The properties of an operator, as its open card holds them: why it cannot be executed, its code, the parameters
 * its code declares, and the form of the rest.
 */
export function OperatorProperties({
  operator,
  schema,
  inputSchemas,
  problem,
  controls,
  disabled,
  codeReadOnly = disabled,
  onProperty,
  onOpenCode,
  parametersProblem,
  onAddParameter,
}: OperatorPropertiesProps) {
  const language = codeLanguage(operator.operatorType);
  const declaresParameters = udfParametersProperty in (schema.jsonSchema.properties ?? {});

  return (
    <div className="space-y-4">
      <ErrorAlert error={problem} />
      {language && onOpenCode && (
        <Button
          variant="outline"
          className="w-full"
          onClick={onOpenCode}>
          <CodeIcon />
          {codeReadOnly ? "View" : "Edit"} the {codeLanguageNames[language]} code
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
    </div>
  );
}
