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
import type { ResourceScope } from "@/components/resource/api";
import type { Operator, WorkflowContent } from "@/lib/workflow/model";
import type { OperatorMetadata } from "@/lib/workflow/operator-schema";
import { useCardDensity } from "../use-card-density";
import { useChipsShown } from "../use-chips-shown";
import { OperatorProperties } from "./operator-properties";
import { WorkflowCanvas } from "./workflow-canvas";

export interface WorkflowViewProps {
  content: WorkflowContent;
  metadata: OperatorMetadata;
  /**
   * Whose datasets and models a chip looks up once it is opened: those the viewer may read, if they are signed in,
   * or else the public ones.
   */
  resourceScope: ResourceScope;
}

/**
 * A workflow to look at, as the hub shows a public one: its canvas, where each operator's card opens to show its
 * properties, and the chips above the cards name the datasets and models they read, which open to what the viewer
 * may read of them. Nothing in it can be changed.
 */
export function WorkflowView({ content, metadata, resourceScope }: WorkflowViewProps) {
  const schemas = useMemo(() => new Map(metadata.operators.map(schema => [schema.operatorType, schema])), [metadata]);
  const [density] = useCardDensity();
  const [chips] = useChipsShown();
  /** The operator whose card is open. */
  const [editing, setEditing] = useState<string>();

  function properties(operator: Operator) {
    const schema = schemas.get(operator.operatorType);
    return (
      schema && (
        <OperatorProperties
          operator={operator}
          schema={schema}
          inputSchemas={[]}
          disabled
          onProperty={() => {}}
        />
      )
    );
  }

  return (
    <div className="flex min-h-0 flex-1 rounded-lg border">
      <div className="min-w-0 flex-1">
        <WorkflowCanvas
          content={content}
          schemas={schemas}
          density={density}
          chips={chips}
          resourceScope={resourceScope}
          readOnly
          editing={editing}
          onEdit={setEditing}
          card={properties}
        />
      </div>
    </div>
  );
}
