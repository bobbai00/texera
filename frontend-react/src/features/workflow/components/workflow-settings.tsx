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

import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkflowSettings } from "@/lib/workflow/model";

export interface WorkflowSettingsFormProps {
  settings: WorkflowSettings;
  /** Whether the settings can only be read, as by someone who may only view the workflow. */
  readonly: boolean;
  onSave: (settings: WorkflowSettings) => void;
}

/** How the engine moves data between operators (WorkflowSettings.scala): each row on as soon as it is made, or
 * each operator's output whole before the next starts. */
const executionModes = { PIPELINED: "Pipelined", MATERIALIZED: "Materialized" };

/** How the workflow is executed: its execution mode and the size of the batches between its operators. */
export function WorkflowSettingsForm({ settings, readonly, onSave }: WorkflowSettingsFormProps) {
  const [mode, setMode] = useState(settings.executionMode ?? "PIPELINED");
  const [batchSize, setBatchSize] = useState(String(settings.dataTransferBatchSize));
  const size = Number(batchSize);
  const valid = Number.isInteger(size) && size >= 1;
  const changed = mode !== (settings.executionMode ?? "PIPELINED") || size !== settings.dataTransferBatchSize;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid) onSave({ ...settings, executionMode: mode, dataTransferBatchSize: size });
  }

  return (
    <form
      aria-label="Settings"
      className="space-y-4"
      onSubmit={submit}>
      <p className="text-sm text-muted-foreground">How the workflow is executed.</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="execution-mode">Execution mode</FieldLabel>
          <Select
            value={mode}
            disabled={readonly}
            onValueChange={setMode}>
            <SelectTrigger id="execution-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {Object.entries(executionModes).map(([value, label]) => (
                <SelectItem
                  key={value}
                  value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Pipelined passes each row on as soon as it is made; materialized lets each operator finish first.
          </FieldDescription>
        </Field>
        <Field data-invalid={!valid}>
          <FieldLabel htmlFor="batch-size">Batch size</FieldLabel>
          <Input
            id="batch-size"
            type="number"
            min={1}
            step={1}
            value={batchSize}
            disabled={readonly}
            aria-invalid={!valid}
            onChange={event => setBatchSize(event.target.value)}
          />
          <FieldDescription>How many rows go from one operator to the next at a time.</FieldDescription>
          {!valid && <FieldError>The batch size is a whole number of at least 1.</FieldError>}
        </Field>
      </FieldGroup>
      {!readonly && (
        <Button
          type="submit"
          disabled={!valid || !changed}>
          Save
        </Button>
      )}
    </form>
  );
}
