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

import { operatorSpacing } from "@/lib/workflow/canvas-geometry";
import { newOperator, type OperatorMetadata, type OperatorSchema } from "@/lib/workflow/operator-schema";
import type { Link, Operator, Point, WorkflowContent, WorkflowPiece } from "@/lib/workflow/model";
import { emptyContent } from "@/lib/workflow/model";
import metadata from "./fixtures/operator-metadata.json";

/** Fourteen operator types exactly as a Texera backend describes them, with the whole tree of menu groups. */
export const operatorMetadata = metadata as unknown as OperatorMetadata;

export function schemaOf(operatorType: string): OperatorSchema {
  const schema = operatorMetadata.operators.find(candidate => candidate.operatorType === operatorType);
  if (!schema) throw new Error(`The test fixture has no operator type ${operatorType}.`);
  return schema;
}

/** A new operator of a type, with an id that reads well in a test, such as "scan". */
export function operator(operatorType: string, operatorID: string, properties: Record<string, unknown> = {}): Operator {
  const made = newOperator(schemaOf(operatorType), operatorID);
  return { ...made, operatorProperties: { ...made.operatorProperties, ...properties } };
}

/** A link from the first output port of one operator to an input port of another. */
export function link(from: string, to: string, inputPort = 0, outputPort = 0): Link {
  return {
    linkID: `${from}->${to}:${inputPort}`,
    source: { operatorID: from, portID: `output-${outputPort}` },
    target: { operatorID: to, portID: `input-${inputPort}` },
  };
}

/** A workflow of these operators, in a row from left to right, and these links. */
export function workflowContent(operators: Operator[], links: Link[] = []): WorkflowContent {
  return {
    ...emptyContent,
    operators,
    operatorPositions: Object.fromEntries(
      operators.map(({ operatorID }, index) => [operatorID, { x: index * 300, y: 0 }])
    ),
    links,
  };
}

/**
 * The same workflow with its operators where arranging would put them, each in its column and row of the canvas,
 * counted from the top left: [0, 0], then [1, 0] to its right and [0, 1] under it.
 */
export function inColumns(content: WorkflowContent, places: Record<string, [number, number]>): WorkflowContent {
  return {
    ...content,
    operatorPositions: Object.fromEntries(
      Object.entries(places).map(([id, [column, row]]) => [
        id,
        { x: column * operatorSpacing.column, y: row * operatorSpacing.row },
      ])
    ),
  };
}

/** A piece of a workflow, to add to a document: these operators, each at its place or at the top left, and links. */
export function piece(operators: Operator[], links: Link[] = [], places: Record<string, Point> = {}): WorkflowPiece {
  return {
    operators,
    operatorPositions: Object.fromEntries(
      operators.map(({ operatorID }) => [operatorID, places[operatorID] ?? { x: 0, y: 0 }])
    ),
    links,
    commentBoxes: [],
  };
}
