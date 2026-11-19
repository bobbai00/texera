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
import { cn } from "cn";
import type { OperatorProgress } from "@/lib/execution/client";
import type { Mark } from "@/lib/workflow/diff";
import type { Operator, PortDescription } from "@/lib/workflow/model";
import type { Collaborator } from "@/lib/workflow/room";
import { operatorImage } from "../operator-images";
import { presenceClassNames } from "../presence";

export interface OperatorNodeData extends Record<string, unknown> {
  operator: Operator;
  /** The name of the operator's type, such as "CSV File Scan". */
  typeName: string;
  /** Why the operator cannot be executed as it is. */
  problem?: string;
  progress?: OperatorProgress;
  /** The other people who have the operator selected. */
  selectedBy?: Collaborator[];
  /** How the operator differs from what it is compared with, as when a version is shown. */
  mark?: Mark;
}

export type OperatorNodeType = Node<OperatorNodeData, "operator">;

const markClassNames: Record<Mark, string> = {
  added: "border-success ring-3 ring-success/25",
  changed: "border-warning ring-3 ring-warning/25",
  removed: "border-dashed border-destructive opacity-60",
};
const markNames: Record<Mark, string> = { added: "Added", changed: "Changed", removed: "Removed" };
const markBadgeClassNames: Record<Mark, string> = {
  added: "bg-success",
  changed: "bg-warning",
  removed: "bg-destructive",
};

/** How the tile and the line under the name look while the workflow executes. */
const stateClassNames: Record<string, { tile: string; text: string }> = {
  Running: { tile: "border-warning", text: "text-warning" },
  Pausing: { tile: "border-warning", text: "text-warning" },
  Paused: { tile: "border-warning", text: "text-warning" },
  Completed: { tile: "border-success", text: "text-success" },
};

/**
 * An operator on the canvas, as the Angular app draws one: a tile with its picture and its ports, and under it its
 * name, with what it is doing while the workflow executes. The tile is all of its place on the canvas, so a
 * workflow laid out in either app looks the same in both.
 */
export function OperatorNode({ data, selected }: NodeProps<OperatorNodeType>) {
  const { operator, typeName, problem, progress, selectedBy = [], mark } = data;
  const image = operatorImage(operator.operatorType);
  const name = operator.customDisplayName || typeName;
  const state = progress && stateClassNames[progress.state];

  return (
    <div
      title={problem}
      className={cn(
        "relative flex size-15 items-center justify-center rounded-xl border bg-card text-card-foreground shadow-xs",
        state?.tile,
        problem && "border-destructive",
        mark && markClassNames[mark],
        selected && "border-ring ring-3 ring-ring/50",
        operator.isDisabled && "opacity-50"
      )}>
      {selectedBy.length > 0 && (
        <ul
          aria-label="Selected by"
          className="absolute bottom-full left-1/2 mb-1.5 flex -translate-x-1/2 gap-1">
          {selectedBy.map(collaborator => (
            <li
              key={collaborator.clientId}
              className={cn(
                "rounded-sm px-1 text-xs whitespace-nowrap text-primary-foreground",
                presenceClassNames(collaborator).background
              )}>
              {collaborator.name}
            </li>
          ))}
        </ul>
      )}
      {mark && (
        <span
          className={cn(
            "absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap text-primary-foreground",
            markBadgeClassNames[mark]
          )}>
          {markNames[mark]}
        </span>
      )}
      {image && (
        <img
          src={image}
          alt=""
          className="size-9 dark:invert"
        />
      )}
      <div className="absolute top-full left-1/2 mt-1.5 w-40 -translate-x-1/2 text-center">
        <p className="line-clamp-2 text-sm leading-tight font-medium">{name}</p>
        {progress ? (
          <p className={cn("truncate text-xs text-muted-foreground", state?.text)}>
            {progress.state} · {progress.outputRows.toLocaleString("en-US")} rows
          </p>
        ) : problem ? (
          <p className="line-clamp-2 text-xs text-destructive">{problem}</p>
        ) : (
          // The type is said only where the name does not say it already.
          name !== typeName && <p className="truncate text-xs text-muted-foreground">{typeName}</p>
        )}
      </div>
      <Ports
        side="input"
        ports={operator.inputPorts}
      />
      <Ports
        side="output"
        ports={operator.outputPorts}
      />
    </div>
  );
}

/** The ports of one side, spread evenly down that edge of the tile. A link starts or ends on a port. */
function Ports({ side, ports }: { side: "input" | "output"; ports: PortDescription[] }) {
  return ports.map((port, index) => (
    <Handle
      key={port.portID}
      id={port.portID}
      type={side === "input" ? "target" : "source"}
      position={side === "input" ? Position.Left : Position.Right}
      title={port.displayName || undefined}
      aria-label={`${side === "input" ? "Input" : "Output"} port ${index + 1}`}
      className="size-2.5!"
      style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%` }}
    />
  ));
}
