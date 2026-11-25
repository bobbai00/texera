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
import { CornerDownLeftIcon, type LucideIcon, MinusIcon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useFloatingArea, useSize } from "./area-context";
import { type Dock, type Handle, handlesOf, keptInside, moved, type Rect, resized, type Size } from "./geometry";
import { type FloatingPanelState, sizeOf } from "./use-floating-panel";

export interface FloatingPanelProps {
  /** The panel's state, from `useFloatingPanel`. */
  panel: FloatingPanelState;
  title: string;
  /** What assistive technology calls the panel, where its title says less, as "Code of Filter". Its title otherwise. */
  label?: string;
  icon: LucideIcon;
  /** A word or two after the title, such as how an execution stands. A minimized panel still says it. */
  status?: ReactNode;
  /** Buttons of the panel's own, in its header. */
  actions?: ReactNode;
  /** The views the panel switches between, as a column of icons down its side. A minimized panel keeps only these. */
  rail?: ReactNode;
  /** Closes what the panel shows, where that is more than minimizing it, as for an operator's code. */
  onClose?: () => void;
  /** Says what closing does, as "Close the code". */
  closeLabel?: string;
  children: ReactNode;
}

/** The least a panel is resized to: room for its header and a line or two of what it holds. */
const minSize: Size = { width: 240, height: 120 };

/** How far the pointer goes before a press on the header moves the panel, so that a click moves nothing. */
const dragThreshold = 4;

/** Where the header is pressed to use something in it, not to move the panel. */
const controls = "button, a, input, select, textarea, [role='tab'], [role='combobox']";

const dockClassNames: Record<Dock, string> = {
  left: "top-0 left-0",
  right: "top-0 right-0",
  bottom: "bottom-0 left-0",
};

const handleClassNames: Record<Handle, string> = {
  left: "inset-y-0 left-0 w-1.5 cursor-ew-resize",
  right: "inset-y-0 right-0 w-1.5 cursor-ew-resize",
  top: "inset-x-0 top-0 h-1.5 cursor-ns-resize",
  bottom: "inset-x-0 bottom-0 h-1.5 cursor-ns-resize",
  "top-right": "top-0 right-0 size-3 cursor-nesw-resize",
  "bottom-left": "bottom-0 left-0 size-3 cursor-nesw-resize",
  "bottom-right": "right-0 bottom-0 size-3 cursor-nwse-resize",
};

/**
 * A panel that floats over the canvas, or whatever else its `FloatingArea` holds. It is docked to an edge of the area
 * until the user drags it by its header elsewhere, and goes back with "Dock". It is resized by the edges and the
 * corner away from the edge it is docked to, and minimized to a button, or to its rail of views if it has one, in
 * the place it is docked. The one the user touched last is in front. The browser keeps all of it for next time.
 */
export function FloatingPanel({
  panel,
  title,
  label = title,
  icon: Icon,
  status,
  actions,
  rail,
  onClose,
  closeLabel = `Close ${title}`,
  children,
}: FloatingPanelProps) {
  const area = useFloatingArea();
  const { room, order, raise, cover } = area;
  const { id, dock, placement, place, minimized, setMinimized } = panel;
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const frameSize = useSize(frame);
  /** Where the panel is, and how big, while the user drags it or one of its edges. */
  const [live, setLive] = useState<Rect>();
  const { width, height } = sizeOf(panel);
  const docked = placement.at === undefined;

  // A docked panel says how much of its edge it covers, so that what is under it can make room.
  const coveredWidth = Math.min(width, area.size?.width ?? width);
  const coveredHeight = Math.min(height ?? 0, area.size?.height ?? 0);
  useLayoutEffect(() => {
    cover(id, docked && !minimized ? { dock, size: { width: coveredWidth, height: coveredHeight } } : undefined);
    return () => cover(id, undefined);
  }, [cover, id, dock, docked, minimized, coveredWidth, coveredHeight]);

  // A panel that is shown again comes in front of the others.
  useEffect(() => {
    if (!minimized) raise(id);
  }, [raise, id, minimized]);

  const zIndex = 10 + order.indexOf(id);

  if (minimized) {
    return (
      <div
        className={cn("pointer-events-auto absolute", dockClassNames[dock])}
        style={{ zIndex }}>
        {rail ? (
          <Card className="gap-0 p-1 shadow-md">{rail}</Card>
        ) : (
          <Button
            variant="outline"
            title={`Show ${label}`}
            className="bg-popover shadow-md"
            onClick={() => setMinimized(false)}>
            <Icon />
            {title}
            {status && (
              <>
                {/* The title and the status are read as two words, not run together. */}{" "}
                <span className="text-muted-foreground">{status}</span>
              </>
            )}
          </Button>
        )}
      </div>
    );
  }

  /** Follows the pointer from a press on the panel until it is let go, and keeps where the panel then is. */
  function follow(
    event: ReactPointerEvent<HTMLElement>,
    step: (start: Rect, room: Size) => (dx: number, dy: number) => Rect,
    done: (rect: Rect) => void
  ) {
    if (event.button !== 0 || !frame || !room) return;
    const handle = event.currentTarget;
    const [panelBox, roomBox] = [frame.getBoundingClientRect(), room.getBoundingClientRect()];
    const start = {
      x: panelBox.left - roomBox.left,
      y: panelBox.top - roomBox.top,
      width: panelBox.width,
      height: panelBox.height,
    };
    const next = step(start, { width: roomBox.width, height: roomBox.height });
    const [fromX, fromY] = [event.clientX, event.clientY];
    let last: Rect | undefined;
    const onMove = (move: PointerEvent) => {
      const [dx, dy] = [move.clientX - fromX, move.clientY - fromY];
      if (!last && Math.abs(dx) + Math.abs(dy) < dragThreshold) return;
      last = next(dx, dy);
      setLive(last);
    };
    // The pointer is followed wherever it goes on the page, and the handle keeps it, so nothing under the pointer
    // reacts to it on the way.
    const view = handle.ownerDocument.defaultView ?? window;
    const onEnd = () => {
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onEnd);
      view.removeEventListener("pointercancel", onEnd);
      setLive(undefined);
      if (last) done(last);
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know, as one a test makes up, is followed all the same.
    }
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onEnd);
    view.addEventListener("pointercancel", onEnd);
    // Nothing on the page is selected while the panel moves.
    event.preventDefault();
  }

  function startMove(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as Element).closest(controls)) return;
    follow(
      event,
      (start, roomSize) => (dx, dy) => moved(start, dx, dy, roomSize),
      ({ x, y }) => place({ at: { x, y } })
    );
  }

  function startResize(event: ReactPointerEvent<HTMLElement>, handle: Handle) {
    follow(
      event,
      (start, roomSize) => (dx, dy) => resized(start, handle, dx, dy, minSize, roomSize),
      rect => {
        // A panel keeps fitting what it holds in the way it is not resized.
        const across = handle !== "top" && handle !== "bottom";
        const down = handle !== "left" && handle !== "right";
        place({
          size: {
            ...placement.size,
            ...(across && { width: rect.width }),
            ...(down && { height: rect.height }),
          },
          // A docked panel stays docked: the edges it is docked by did not move.
          ...(!docked && { at: { x: rect.x, y: rect.y } }),
        });
      }
    );
  }

  // A panel that was moved stays inside its area as the area changes, as when the window is made smaller.
  const at =
    live ??
    (placement.at && frameSize && area.size
      ? keptInside({ ...placement.at, ...frameSize }, area.size)
      : placement.at && { ...placement.at, width, height: height ?? 0 });
  const style: CSSProperties = {
    zIndex,
    width: live?.width ?? width,
    height: live?.height ?? height,
    ...(at && { left: at.x, top: at.y }),
  };

  return (
    <Card
      ref={setFrame}
      role="region"
      aria-label={label}
      style={style}
      className={cn(
        "pointer-events-auto absolute max-h-full max-w-full flex-row gap-0 py-0 shadow-lg",
        !at && dockClassNames[dock]
      )}
      onPointerDownCapture={() => raise(id)}
      onFocusCapture={() => raise(id)}>
      {rail && <div className="flex shrink-0 flex-col border-r p-1">{rail}</div>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-11 shrink-0 cursor-grab touch-none items-center gap-2 border-b pr-1.5 pl-3 select-none active:cursor-grabbing"
          onPointerDown={startMove}>
          <Icon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <h2 className="min-w-0 truncate font-medium">{title}</h2>
          {status && <span className="shrink-0 text-muted-foreground">{status}</span>}
          <div className="ml-auto flex shrink-0 items-center">
            {actions}
            {!docked && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Dock ${title}`}
                title="Dock the panel where it was"
                onClick={() => place({ at: undefined })}>
                <CornerDownLeftIcon />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Minimize ${title}`}
              title="Minimize"
              onClick={() => setMinimized(true)}>
              <MinusIcon />
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={onClose}>
                <XIcon />
              </Button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-auto overflow-y-auto">{children}</div>
      </div>
      {handlesOf[dock].map(handle => (
        <div
          key={handle}
          aria-hidden
          data-handle={handle}
          className={cn("absolute z-10 touch-none", handleClassNames[handle])}
          onPointerDown={event => startResize(event, handle)}
        />
      ))}
    </Card>
  );
}
