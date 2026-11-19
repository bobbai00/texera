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

import { cn } from "cn";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { AreaContext, sameSize, useSize } from "./area-context";
import { coveredBy, type Dock, type Size } from "./geometry";

export interface FloatingAreaProps {
  /** The panels that float over the area. */
  panels: ReactNode;
  className?: string;
  /** What the panels float over, such as a canvas, which fills the area. */
  children: ReactNode;
}

/**
 * A place where panels float over something, such as a workflow's canvas. They stay inside it, a little in from its
 * edges, and the one used last is in front. What lies under them can make room for the docked ones: how far they
 * reach in from each edge is `useFloatingInsets()`.
 */
export function FloatingArea({ panels, className, children }: FloatingAreaProps) {
  const [room, setRoom] = useState<HTMLElement | null>(null);
  const size = useSize(room);
  const [order, setOrder] = useState<string[]>([]);
  const [covers, setCovers] = useState<Record<string, { dock: Dock; size: Size }>>({});

  const raise = useCallback(
    (id: string) =>
      setOrder(current => (current.at(-1) === id ? current : [...current.filter(each => each !== id), id])),
    []
  );
  const cover = useCallback(
    (id: string, docked: { dock: Dock; size: Size } | undefined) =>
      setCovers(current => {
        const { [id]: before, ...others } = current;
        if (!docked) return before ? others : current;
        const same = before?.dock === docked.dock && sameSize(before.size, docked.size);
        return same ? current : { ...others, [id]: docked };
      }),
    []
  );
  const insets = useMemo(() => {
    if (!room || !size) return undefined;
    // The margin is the room's distance from the area's edges.
    const margin = room.offsetLeft;
    const area = { width: size.width + 2 * margin, height: size.height + 2 * margin };
    const reach = coveredBy(Object.values(covers), area);
    const withMargin = (inset: number) => (inset === 0 ? 0 : inset + margin);
    return {
      top: withMargin(reach.top),
      right: withMargin(reach.right),
      bottom: withMargin(reach.bottom),
      left: withMargin(reach.left),
    };
  }, [room, size, covers]);
  const context = useMemo(
    () => ({ room, size, insets, order, raise, cover }),
    [room, size, insets, order, raise, cover]
  );

  return (
    <AreaContext.Provider value={context}>
      <div className={cn("relative isolate", className)}>
        {children}
        {/* The panels' room lets the pointer through to what is under it; each panel takes it back. */}
        <div
          ref={setRoom}
          className="pointer-events-none absolute inset-3">
          {panels}
        </div>
      </div>
    </AreaContext.Provider>
  );
}
