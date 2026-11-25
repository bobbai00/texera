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
// The size of a card and the room around it are the canvas's, which draws cards without dagre: only arranging needs it.
import { operatorCard, operatorSpacing } from "./canvas-geometry";
import type { Point, WorkflowContent } from "./model";

/**
 * Positions that lay the workflow out from left to right, from the top left corner of the canvas: each operator in a
 * column after every one it depends on, with the links as short as they can be all together, so that an operator
 * mostly stands in the column after the furthest one it depends on, and its card as far from the next as
 * `operatorSpacing` says. A workflow laid out for the Angular app's tiles, which stand closer together, may need
 * "Arrange the operators" for its cards to have their room.
 */
export function layout(content: WorkflowContent): Record<string, Point> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "LR",
    ranksep: operatorSpacing.column - operatorCard.width,
    nodesep: operatorSpacing.row - operatorCard.height,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { operatorID } of content.operators) graph.setNode(operatorID, { ...operatorCard });
  // Only a link between two of the workflow's operators counts. One may name an operator that is gone, made while
  // someone else deleted it, and dagre would stand an empty card for it in a column of its own.
  for (const { source, target } of content.links) {
    const [from, to] = [source.operatorID, target.operatorID];
    if (from !== to && graph.hasNode(from) && graph.hasNode(to)) graph.setEdge(from, to);
  }
  dagre.layout(graph);
  return Object.fromEntries(
    content.operators.map(({ operatorID }) => {
      // dagre places the center of each card; the canvas places its top left corner.
      const { x, y } = graph.node(operatorID) as Point;
      return [operatorID, { x: Math.round(x - operatorCard.width / 2), y: Math.round(y - operatorCard.height / 2) }];
    })
  );
}
