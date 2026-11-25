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

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { useContext } from "react";
import { ResourceChip } from "@/components/resource/resource-chip";
import type { ResourcePath } from "@/lib/resource-path";
import { chipEvents } from "../keys";
import { CardCanvasContext } from "./card-canvas";

export interface ResourceChipNodeData extends Record<string, unknown> {
  /** The version the operator reads, and the file in it where it reads one. */
  path: ResourcePath;
}

export type ResourceChipNodeType = Node<ResourceChipNodeData, "resource">;

/**
 * A version of a dataset or a model that an operator reads, as a chip above its card, from whose bottom edge a line
 * goes to the card. It is the operator's, not a part of the workflow: nothing selects, moves, links or removes it, and
 * what is pressed or clicked on it, and in what it opens, is its own (`chipEvents`).
 */
export function ResourceChipNode({ data }: NodeProps<ResourceChipNodeType>) {
  const { resourceScope } = useContext(CardCanvasContext);
  return (
    <div {...chipEvents}>
      <ResourceChip
        path={data.path}
        scope={resourceScope}
        // A press on it is its own, not the canvas's to pan.
        className="nodrag nopan"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="opacity-0"
      />
    </div>
  );
}
