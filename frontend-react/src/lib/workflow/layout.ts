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

import dagre from "@dagrejs/dagre";
import type { Point, WorkflowContent } from "./model";

/**
 * An operator on the canvas is a tile, which its position places by its top left corner, with its name under it,
 * as the Angular app draws it: workflows laid out there fit here. In pixels.
 */
export const operatorTile = { width: 60, height: 60 };
/** The room the name under a tile takes, which arranging leaves free around it. */
export const operatorLabel = { width: 160, height: 44 };

/** All the room an operator takes: its tile, and its name under it. */
const footprint = { width: operatorLabel.width, height: operatorTile.height + operatorLabel.height };

/** Positions that lay the workflow out from left to right, each operator after the ones it depends on. */
export function layout(content: WorkflowContent): Record<string, Point> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 96 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { operatorID } of content.operators) graph.setNode(operatorID, { ...footprint });
  for (const { source, target } of content.links) graph.setEdge(source.operatorID, target.operatorID);
  dagre.layout(graph);
  return Object.fromEntries(
    content.operators.map(({ operatorID }) => {
      // dagre places the center of all the room; the canvas places the top left corner of the tile in it.
      const { x, y } = graph.node(operatorID) as Point;
      return [operatorID, { x: Math.round(x - operatorTile.width / 2), y: Math.round(y - footprint.height / 2) }];
    })
  );
}
