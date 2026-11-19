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

/** How big something is, in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Where something is in its area, in CSS pixels from the area's top left corner, and how big it is. */
export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * The edge of its area a panel is docked to, until it is moved, and goes back to: the top of the left edge, the top
 * of the right edge, or the left end of the bottom edge.
 */
export type Dock = "left" | "right" | "bottom";

/** An edge or a corner of a panel, dragged to resize it. */
export type Handle = "left" | "right" | "top" | "bottom" | "top-right" | "bottom-left" | "bottom-right";

/** A docked panel is resized by the edges and the corner away from the edge it is docked to. */
export const handlesOf: Record<Dock, Handle[]> = {
  left: ["right", "bottom", "bottom-right"],
  right: ["left", "bottom", "bottom-left"],
  bottom: ["top", "right", "top-right"],
};

/** How far in from each edge of an area something reaches. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const noInsets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The value, or the nearest end of the range. A range that is empty is only its lower end. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Where a panel goes when it is dragged by `dx, dy` from where it was: as far as it can go inside its area. */
export function moved(start: Rect, dx: number, dy: number, area: Size): Rect {
  return {
    ...start,
    x: clamp(start.x + dx, 0, area.width - start.width),
    y: clamp(start.y + dy, 0, area.height - start.height),
  };
}

/**
 * A panel after one of its edges or corners is dragged by `dx, dy`: the other edges stay where they were, and the
 * panel is never smaller than `min` nor reaches out of its area.
 */
export function resized(start: Rect, handle: Handle, dx: number, dy: number, min: Size, area: Size): Rect {
  let { x, y, width, height } = start;
  const [right, bottom] = [x + width, y + height];
  if (handle.includes("right")) width = clamp(width + dx, min.width, area.width - x);
  if (handle.includes("left")) {
    x = clamp(x + dx, 0, right - min.width);
    width = right - x;
  }
  if (handle.includes("bottom")) height = clamp(height + dy, min.height, area.height - y);
  if (handle.includes("top")) {
    y = clamp(y + dy, 0, bottom - min.height);
    height = bottom - y;
  }
  return { x, y, width, height };
}

/** A panel that was moved, kept inside its area as the area is now: it slides back in, as little as it must. */
export function keptInside(rect: Rect, area: Size): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return { width, height, x: clamp(rect.x, 0, area.width - width), y: clamp(rect.y, 0, area.height - height) };
}

/**
 * The room that the docked panels leave free in their area: how far each reaches in from the edge it is docked to.
 * Panels that leave less than a third of the area free across or down are not made room for, as on a phone, where
 * they are better minimized than worked around.
 */
export function coveredBy(docked: { dock: Dock; size: Size }[], area: Size): Insets {
  const insets = { ...noInsets };
  for (const { dock, size } of docked) {
    const reach = dock === "bottom" ? size.height : size.width;
    insets[dock] = Math.max(insets[dock], reach);
  }
  const freeAcross = area.width - insets.left - insets.right;
  const freeDown = area.height - insets.top - insets.bottom;
  return freeAcross < area.width / 3 || freeDown < area.height / 3 ? { ...noInsets } : insets;
}
