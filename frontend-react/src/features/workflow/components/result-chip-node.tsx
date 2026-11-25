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
import { CylinderIcon } from "lucide-react";
import { useContext } from "react";
import type { OperatorResult } from "@/lib/execution/client";
import { formatRows } from "@/lib/format";
import { chipEvents } from "../keys";
import { CardCanvasContext } from "./card-canvas";

export interface ResultChipNodeData extends Record<string, unknown> {
  /** The operator whose result it is, and the name it goes by. */
  operatorId: string;
  name: string;
  result: OperatorResult;
}

export type ResultChipNodeType = Node<ResultChipNodeData, "result">;

/**
 * What the execution shown kept of an operator's output, as a chip under its card, on whose top edge a line from the
 * operator's output ends: its rows, or a visualization, which its title says whole, as the chip cuts many rows short.
 * A click shows it. Like a chip of what an operator reads, it is the operator's, not a part of the workflow.
 */
export function ResultChipNode({ data: { operatorId, name, result } }: NodeProps<ResultChipNodeType>) {
  const { onShowResult } = useContext(CardCanvasContext);
  const kept = result.kind === "table" ? formatRows(result.totalRows) : "Visualization";
  return (
    <div {...chipEvents}>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="opacity-0"
      />
      <button
        type="button"
        title={`Show the result of ${name}: ${kept}`}
        disabled={!onShowResult}
        // A press on it is its own, not the canvas's to pan.
        className="nodrag nopan flex h-7.5 w-29 items-center gap-1.5 rounded-full border border-primary bg-card px-2.5 text-xs shadow-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onShowResult?.(operatorId)}>
        <CylinderIcon
          aria-hidden
          className="size-3.5 shrink-0 text-primary"
        />
        <span className="sr-only">Result of {name}:</span> <span className="min-w-0 truncate tabular-nums">{kept}</span>
      </button>
    </div>
  );
}
