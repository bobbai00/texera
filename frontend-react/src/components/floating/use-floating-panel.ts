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

import { useCallback } from "react";
import { useStoredState } from "@/components/use-stored-state";
import type { Dock } from "./geometry";

export interface FloatingPanelOptions {
  /** Names the panel where this browser keeps how the user left it. */
  id: string;
  /** The edge the panel is docked to until the user moves it, and goes back to. */
  dock: Dock;
  /** Its size until the user resizes it. Without a height, it is as tall as what it holds, up to its area's height. */
  size: { width: number; height?: number };
}

/** How the user left a panel. */
export interface Placement {
  minimized: boolean;
  /** Where they moved it to, from the top left corner of its area's room. A panel without one is docked. */
  at?: { x: number; y: number };
  /** The width and the height they gave it, each once they resized it that way. */
  size?: { width?: number; height?: number };
}

/** A floating panel's state, from `useFloatingPanel`, given to the `FloatingPanel` that draws it. */
export interface FloatingPanelState extends FloatingPanelOptions {
  placement: Placement;
  /** Changes how the panel is placed. */
  place: (change: Partial<Placement>) => void;
  minimized: boolean;
  setMinimized: (minimized: boolean) => void;
}

/**
 * A floating panel, as the user leaves it: minimized or not, docked or moved, and the size they gave it. Their
 * browser keeps it for the next time the panel is shown. What uses the panel can minimize it or show it again, as
 * when what it shows changes.
 */
export function useFloatingPanel(options: FloatingPanelOptions): FloatingPanelState {
  const [placement, setPlacement] = useStoredState(`texera.panel.${options.id}`, placementOf);
  const place = useCallback(
    (change: Partial<Placement>) => setPlacement(current => ({ ...current, ...change })),
    [setPlacement]
  );
  const setMinimized = useCallback((minimized: boolean) => place({ minimized }), [place]);
  return { ...options, placement, place, minimized: placement.minimized, setMinimized };
}

/** How the user left a panel, from what the browser kept: anything it cannot use is left out. */
export function placementOf(kept: unknown): Placement {
  const { minimized, at, size } = isObject(kept) ? kept : {};
  const point = isObject(at) && isLength(at.x) && isLength(at.y) ? { x: at.x, y: at.y } : undefined;
  const width = isObject(size) && isLength(size.width) && size.width > 0 ? size.width : undefined;
  const height = isObject(size) && isLength(size.height) && size.height > 0 ? size.height : undefined;
  return {
    minimized: minimized === true,
    ...(point && { at: point }),
    ...((width ?? height) !== undefined && { size: { width, height } }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The size a panel has now: the one the user gave it, or else its own. */
export function sizeOf({ placement, size }: Pick<FloatingPanelState, "placement" | "size">): {
  width: number;
  height?: number;
} {
  return { width: placement.size?.width ?? size.width, height: placement.size?.height ?? size.height };
}
