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

import { createContext, useContext, useEffect, useState } from "react";
import { type Dock, type Insets, noInsets, type Size } from "./geometry";

/** What a panel knows of the `FloatingArea` it floats in. */
export interface FloatingAreaContext {
  /** The element the panels stand in: the area, less a margin all round. */
  room: HTMLElement | null;
  /** How big the room is now, once it is measured. */
  size: Size | undefined;
  /** How far the docked panels reach in from each edge of the area, margin included, once the area is measured. */
  insets: Insets | undefined;
  /** The panels from the one at the back to the one in front. */
  order: string[];
  /** Brings a panel in front of the others, as when it is used. */
  raise: (id: string) => void;
  /** A docked panel says which edge it covers, and how much of it; one that is not docked, or not open, says so. */
  cover: (id: string, docked: { dock: Dock; size: Size } | undefined) => void;
}

export const AreaContext = createContext<FloatingAreaContext | undefined>(undefined);

/** The area a panel floats in. A panel is used only inside a `FloatingArea`. */
export function useFloatingArea(): FloatingAreaContext {
  const context = useContext(AreaContext);
  if (!context) throw new Error("A floating panel stands in a FloatingArea.");
  return context;
}

/**
 * How far the docked panels of the area reach in from each of its edges, in CSS pixels: what lies under them is
 * covered there. It is not known until the area is measured, a moment after it is first drawn, so what makes room
 * for the panels from the start waits for it. Outside a `FloatingArea`, nothing covers anything.
 */
export function useFloatingInsets(): Insets | undefined {
  const context = useContext(AreaContext);
  return context ? context.insets : noInsets;
}

export function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/** An element's size as it is now, and again each time it changes. */
export function useSize(element: HTMLElement | null): Size | undefined {
  const [size, setSize] = useState<Size>();
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(current => (current && sameSize(current, { width, height }) ? current : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
