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

import { act } from "@testing-library/react";

/** A place on the screen, as a mouse event tells it. */
export interface ScreenPoint {
  clientX: number;
  clientY: number;
}

/**
 * Drags something on a workflow's canvas, such as an operator's card, as a mouse does: pressed on it at the first
 * place, then moved through the others and let go at the last, on the window, where d3, which React Flow drags with,
 * follows it. React Flow starts a drag once the mouse has moved a little, and what is dragged follows the mouse from
 * there, so the first move starts it. jsdom gives an event no window of its own, nor the canvas a size, which d3 and
 * React Flow's panning at the canvas's edge need: the canvas is given one large enough that nothing is near its edge.
 */
export function dragOnCanvas(element: HTMLElement, [from, ...through]: [ScreenPoint, ...ScreenPoint[]]) {
  const canvas = element.closest<HTMLElement>(".react-flow");
  if (!canvas) throw new Error("What is dragged is not on a canvas.");
  const size = 10_000;
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: size, bottom: size, width: size, height: size }) as DOMRect;
  const mouse = (type: string, at: ScreenPoint) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...at });
    Object.defineProperty(event, "view", { value: window });
    return event;
  };
  act(() => {
    element.dispatchEvent(mouse("mousedown", from));
    for (const at of through) window.dispatchEvent(mouse("mousemove", at));
    window.dispatchEvent(mouse("mouseup", through.at(-1) ?? from));
  });
}
