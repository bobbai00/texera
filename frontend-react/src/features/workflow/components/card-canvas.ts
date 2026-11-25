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

import { createContext } from "react";
import type { WorkflowCanvasProps } from "./workflow-canvas";

/**
 * What an operator's card and the chips around it know of the canvas they are on, the same for every card there: how
 * much the cards say, whether the canvas is only looked at, which card is open, whether its operator was just added,
 * what it holds, what the card's buttons do, whose datasets and models a chip looks up, and what showing a result is.
 * React Flow gives a node only its own data, so the canvas puts this where each of its cards and chips finds it.
 */
export type CardCanvas = Pick<
  WorkflowCanvasProps,
  | "density"
  | "readOnly"
  | "onPatch"
  | "editing"
  | "justAdded"
  | "openToRead"
  | "onEdit"
  | "card"
  | "executeUpTo"
  | "resourceScope"
  | "onShowResult"
>;

export const CardCanvasContext = createContext<CardCanvas>({});

/** The handle on the top edge of a card where the lines from the chips of the datasets and models it reads end. */
export const resourcesHandle = "resources";

/**
 * The parts of an operator's card that the canvas names: those that say something of the operator, which describe it
 * to whoever comes to it with the keyboard, and the open card, which Enter on its operator gives the keyboard.
 */
export type CardPart = "held" | "left-out" | "summary" | "settings" | "problem" | "execution" | "properties";

/** The id of a part of an operator's card, by which the canvas names it. */
export const cardPartId = (operatorId: string, part: CardPart) => `operator-${operatorId}-${part}`;
