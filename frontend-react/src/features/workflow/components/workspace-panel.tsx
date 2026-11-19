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

import { type Announcements, closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { FloatingPanel } from "@/components/floating/floating-panel";
import type { FloatingPanelState } from "@/components/floating/use-floating-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type WorkspaceView, workspaceViews } from "../workspace-views";

export interface WorkspacePanelProps {
  panel: FloatingPanelState;
  /** The view that is shown, which is one of `views`. */
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  /** The views the panel offers, in the order of its rail, each with what it holds. */
  views: { view: WorkspaceView; content: ReactNode }[];
  /** The user put the views of the rail in this order. */
  onReorder: (views: WorkspaceView[]) => void;
}

/** How far the pointer goes before a press on an icon drags it: less is a click, which shows the icon's view. */
const dragDistance = 4;

/** The rail says what moved itself, in the same words for the pointer and the keyboard, so dnd-kit says nothing. */
const silent: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/**
 * The workflow's workspace: its operators to add, its versions, its executions and its settings, one at a time, as
 * a floating panel with a rail of their icons. Minimized, the panel keeps its rail, and a view chosen there shows
 * the panel again. The icons are put in another order by dragging them, or with Alt and an arrow key.
 */
export function WorkspacePanel({ panel, view, onView, views, onReorder }: WorkspacePanelProps) {
  const order = views.map(each => each.view);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: dragDistance } }));
  /** What the rail last said about a move, for assistive technology. */
  const [said, setSaid] = useState("");
  /** Whether an icon was just dragged: the click that ends the drag shows no panel. */
  const dragged = useRef(false);

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= order.length) return;
    onReorder(arrayMove(order, from, to));
    setSaid(`${workspaceViews[order[from]].title} is now ${to + 1} of ${order.length} in the rail.`);
  }

  const { title, icon } = workspaceViews[view];
  return (
    <Tabs
      value={view}
      onValueChange={next => onView(next as WorkspaceView)}
      orientation="vertical">
      <FloatingPanel
        panel={panel}
        title={title}
        icon={icon}
        rail={
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            accessibility={{
              announcements: silent,
              screenReaderInstructions: { draggable: "Press Alt and the up or down arrow to move it in the rail." },
            }}
            onDragStart={() => {
              dragged.current = true;
            }}
            onDragEnd={({ active, over }) => {
              // A drag that ends without a click to swallow does not swallow the next one.
              setTimeout(() => (dragged.current = false));
              if (over) move(order.indexOf(active.id as WorkspaceView), order.indexOf(over.id as WorkspaceView));
            }}
            onDragCancel={() => setTimeout(() => (dragged.current = false))}>
            <SortableContext
              items={order}
              strategy={verticalListSortingStrategy}>
              <TabsList
                variant="line"
                aria-label="Workspace"
                className="gap-1 p-0">
                {order.map((each, index) => (
                  <RailIcon
                    key={each}
                    view={each}
                    onOpen={() => {
                      if (!dragged.current) panel.setMinimized(false);
                    }}
                    onMove={step => move(index, index + step)}
                  />
                ))}
              </TabsList>
            </SortableContext>
            <p
              aria-live="polite"
              className="sr-only">
              {said}
            </p>
          </DndContext>
        }>
        {views.map(({ view: each, content }) => (
          <TabsContent
            key={each}
            value={each}
            className="p-3">
            {content}
          </TabsContent>
        ))}
      </FloatingPanel>
    </Tabs>
  );
}

/** A view's icon in the rail: a tab that shows the view, and that can be dragged or moved to another place. */
function RailIcon({
  view,
  onOpen,
  onMove,
}: {
  view: WorkspaceView;
  onOpen: () => void;
  onMove: (step: -1 | 1) => void;
}) {
  const { title, icon: Icon } = workspaceViews[view];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: view });

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const icon = event.currentTarget;
    onMove(event.key === "ArrowUp" ? -1 : 1);
    // The icon keeps the keyboard where it went.
    requestAnimationFrame(() => icon.focus());
  }

  return (
    <TabsTrigger
      ref={setNodeRef}
      value={view}
      aria-label={title}
      title={title}
      // Only how to move it, of what dnd-kit says of an icon: it stays a tab, in the tabs' own order for the keyboard.
      aria-describedby={attributes["aria-describedby"]}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition: isDragging ? "none" : transition }}
      className={cn(
        "size-9 flex-none touch-none justify-center p-0",
        isDragging && "z-10 cursor-grabbing bg-accent shadow-sm"
      )}
      onClick={onOpen}
      onKeyDown={handleKeyDown}>
      <Icon />
    </TabsTrigger>
  );
}
