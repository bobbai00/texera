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

import { useMemo, useState } from "react";
import type { WorkflowContent } from "@/lib/workflow/model";
import type { OperatorMetadata } from "@/lib/workflow/operator-schema";
import { PropertyPanel } from "./property-panel";
import { type Selection, WorkflowCanvas } from "./workflow-canvas";

export interface WorkflowViewProps {
  content: WorkflowContent;
  metadata: OperatorMetadata;
}

/**
 * A workflow to look at, as the hub shows a public one: its canvas, and the properties of the operator that is
 * selected on it. Nothing in it can be changed.
 */
export function WorkflowView({ content, metadata }: WorkflowViewProps) {
  const [selection, setSelection] = useState<Selection>();
  const schemas = useMemo(() => new Map(metadata.operators.map(schema => [schema.operatorType, schema])), [metadata]);
  const typeNames = useMemo(
    () =>
      Object.fromEntries(metadata.operators.map(each => [each.operatorType, each.additionalMetadata.userFriendlyName])),
    [metadata]
  );
  const selected =
    selection?.operators.length === 1
      ? content.operators.find(each => each.operatorID === selection.operators[0])
      : undefined;
  const schema = selected && schemas.get(selected.operatorType);

  return (
    <div className="flex min-h-0 flex-1 rounded-lg border">
      <div className="min-w-0 flex-1">
        <WorkflowCanvas
          content={content}
          typeNames={typeNames}
          readOnly
          onSelect={setSelection}
        />
      </div>
      {selected && schema && (
        <aside className="w-80 shrink-0 overflow-y-auto border-l">
          <PropertyPanel
            key={selected.operatorID}
            operator={selected}
            schema={schema}
            inputSchemas={[]}
            disabled
            onPatch={() => {}}
            onProperty={() => {}}
          />
        </aside>
      )}
    </div>
  );
}
