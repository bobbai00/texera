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

// A workflow as it is saved and as the engine reads it. The backend keeps a workflow's content as JSON without
// a class of its own; these are its shapes, with the names the engine's own classes use (LogicalOp.scala,
// PortDescriptor.scala), so nothing is renamed on the way in or out. An operator or a workflow may carry keys this
// file does not list, such as the Form View's formBinding: they are kept as they are and saved back.

export interface Point {
  x: number;
  y: number;
}

/** One port of an operator on the canvas. portID is "input-0", "output-1": its side and its place on that side. */
export interface PortDescription {
  portID: string;
  displayName?: string;
  /** An input port that takes one link only. */
  disallowMultiInputs?: boolean;
  /** A port the user added, on an operator that allows it. */
  isDynamicPort?: boolean;
  [key: string]: unknown;
}

/** An operator on the canvas: an operator type of the backend, with the values of its properties. */
export interface Operator {
  /** Unique in the workflow: "<operatorType>-operator-<uuid>". */
  operatorID: string;
  operatorType: string;
  operatorVersion: string;
  /** The values of the type's properties, described by its JSON schema. */
  operatorProperties: Record<string, unknown>;
  inputPorts: PortDescription[];
  outputPorts: PortDescription[];
  dynamicInputPorts?: boolean;
  dynamicOutputPorts?: boolean;
  showAdvanced: boolean;
  /** A disabled operator stays on the canvas but is left out of what is compiled and executed. */
  isDisabled?: boolean;
  /** Whether an execution keeps this operator's output for viewing. */
  viewResult?: boolean;
  markedForReuse?: boolean;
  /** The name shown on the canvas. It starts as the type's name. */
  customDisplayName?: string;
  [key: string]: unknown;
}

/** One end of a link. */
export interface PortRef {
  operatorID: string;
  portID: string;
}

/** A link from an output port to an input port. */
export interface Link {
  linkID: string;
  source: PortRef;
  target: PortRef;
}

export interface Comment {
  content: string;
  creationTime: string;
  creatorName: string;
  creatorID: number;
}

/** A note on the canvas with a thread of comments. */
export interface CommentBox {
  commentBoxID: string;
  comments: Comment[];
  commentBoxPosition: Point;
}

/** How a workflow is executed (WorkflowSettings.scala). */
export interface WorkflowSettings {
  dataTransferBatchSize: number;
  executionMode?: string;
  [key: string]: unknown;
}

/** Everything on the canvas: what POST /workflow/persist saves as the workflow's content. */
export interface WorkflowContent {
  operators: Operator[];
  /** Where each operator is on the canvas, by its id. */
  operatorPositions: Record<string, Point>;
  links: Link[];
  commentBoxes: CommentBox[];
  settings: WorkflowSettings;
  [key: string]: unknown;
}

/** Some of what is on a canvas, such as what is copied from it or pasted into it. */
export type WorkflowPiece = Pick<WorkflowContent, "operators" | "operatorPositions" | "links" | "commentBoxes">;

/** The settings of a new workflow, as the backend's own defaults have them (WorkflowSettings.scala). */
export const defaultSettings: WorkflowSettings = { dataTransferBatchSize: 400 };

export const emptyContent: WorkflowContent = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: defaultSettings,
};

/** Reads saved content, filling in the parts that an old or hand-made workflow may lack. */
export function parseContent(json: string | null | undefined): WorkflowContent {
  return contentOf(json ? (JSON.parse(json) as Partial<WorkflowContent>) : {});
}

/** Saved content that was read already, with the parts that an old or hand-made workflow may lack filled in. */
export function contentOf(saved: Partial<WorkflowContent>): WorkflowContent {
  return { ...emptyContent, ...saved, settings: { ...defaultSettings, ...saved.settings } };
}

/** Which side of an operator a port is on, and its place there, from its id. */
export function portIndex(portID: string): { side: "input" | "output"; index: number } {
  const [side, index] = portID.split("-");
  return { side: side === "output" ? "output" : "input", index: Number(index) };
}
