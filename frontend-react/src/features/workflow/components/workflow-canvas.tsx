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

import {
  Background,
  type Connection,
  type EdgeMarker,
  MarkerType,
  Controls,
  type Edge,
  MiniMap,
  type OnSelectionChangeFunc,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
  ViewportPortal,
} from "@xyflow/react";
import { cn } from "cn";
import { MousePointer2Icon } from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFloatingInsets } from "@/components/floating/area-context";
import type { Insets } from "@/components/floating/geometry";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { currentTheme, subscribeToTheme } from "@/lib/theme";
import type { OperatorProgress } from "@/lib/execution/client";
import type { Mark, Marks } from "@/lib/workflow/diff";
import type { ElementIds } from "@/lib/workflow/document";
import { linkProblem } from "@/lib/workflow/links";
import type { Link, Point, PortRef, WorkflowContent } from "@/lib/workflow/model";
import type { Collaborator } from "@/lib/workflow/room";
import { newLinkId } from "@/lib/workflow/operator-schema";
import { operatorDragType } from "../operator-drag";
import { presenceClassNames } from "../presence";
import { CommentNode, type CommentNodeType } from "./comment-node";
import { OperatorNode, type OperatorNodeType } from "./operator-node";

/** What is selected on the canvas. */
export type Selection = Required<ElementIds>;

/** Where the canvas was right-clicked: on what is selected, which the click selects if it was not, or on nothing. */
export interface CanvasTarget {
  /** The place on the canvas. */
  at: Point;
  onSelection: boolean;
}

export interface WorkflowCanvasProps {
  content: WorkflowContent;
  /** The name of each operator type, such as "CSV File Scan". */
  typeNames: Record<string, string>;
  /** Why an operator cannot be executed as it is, by its id. */
  problems?: Record<string, string>;
  /** What each operator is doing in the execution being shown, by its id. */
  progress?: Record<string, OperatorProgress>;
  /** The other people editing the workflow: the canvas shows their pointers, and each operator who has it selected. */
  collaborators?: Collaborator[];
  /**
   * The operators to select and bring into view: the one this user has just added, or what someone else has
   * selected while this user follows them.
   */
  shown?: string[];
  /** A canvas that is only looked at: nothing on it can be moved, linked or removed. */
  readOnly?: boolean;
  /** Where a comment that is being written will go: it is shown there before it is on the canvas. */
  draftComment?: Point;
  /** How the operators and links drawn differ from what they are compared with, as when a version is shown. */
  marks?: Marks;
  /** Whether a small map of the whole workflow is shown in a corner, over the canvas. */
  map?: boolean;
  onMove?: (positions: Record<string, Point>) => void;
  onLink?: (link: Link) => void;
  onRemove?: (elements: ElementIds) => void;
  /** An operator type was dropped on the canvas, at this place. */
  onAddOperator?: (operatorType: string, position: Point) => void;
  /** What is selected changed. */
  onSelect?: (selection: Selection) => void;
  /** The user's pointer moved to this place on the canvas, or left the canvas. */
  onPoint?: (position: Point | undefined) => void;
  /** The items of the menu that opens where the canvas is right-clicked. Without them, no menu opens. */
  menu?: (target: CanvasTarget) => ReactNode;
}

/** How often, at most, the others are told where the pointer is. */
const pointIntervalMs = 50;

/**
 * The room kept around the workflow when it is fitted into the canvas, besides what the panels cover. The names under
 * the tiles are outside them: the room keeps them on the screen.
 */
const fitGap = 64;
/** The room between the canvas's own controls and its edge, or a panel docked there. */
const controlGap = 12;
/** The room kept between what is selected and a panel, when the canvas slides it out from under one. */
const slideGap = 32;

const nodeTypes = { operator: OperatorNode, comment: CommentNode };
type CanvasNode = OperatorNodeType | CommentNodeType;
/**
 * How a link is drawn, in the colors of the tokens: with an arrow at the operator it leads to, and in the color of
 * its mark, if it was added or removed.
 */
const linkColors: Record<Mark | "none", string> = {
  none: "var(--muted-foreground)",
  added: "var(--success)",
  changed: "var(--warning)",
  removed: "var(--destructive)",
};
function linkLook(mark: Mark | undefined): { style: CSSProperties; markerEnd: EdgeMarker } {
  const color = linkColors[mark ?? "none"];
  return {
    style: {
      stroke: color,
      strokeWidth: mark ? 2 : 1.5,
      ...(mark === "removed" && { strokeDasharray: "6 4", opacity: 0.6 }),
    },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
  };
}
/** The node of the comment that is being written, which is not a comment box yet. */
const draftId = "draft-comment";
// One object for "none", so that a canvas without problems or progress is not given a new one on every render.
const none = {};
const nobody: Collaborator[] = [];

/**
 * The canvas of a workflow: its operators and the links between them, to look at or to edit. Where panels float over
 * it, it is drawn once it knows what they cover, so that the workflow is fitted into the rest from the start.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const insets = useFloatingInsets();
  if (!insets) return null;
  return (
    // The provider gives the canvas the way to turn a place on the screen into a place on the canvas.
    <ReactFlowProvider>
      <Canvas
        {...props}
        insets={insets}
      />
    </ReactFlowProvider>
  );
}

function Canvas({
  content,
  typeNames,
  problems = none,
  progress = none,
  collaborators = nobody,
  shown,
  readOnly = false,
  draftComment,
  marks,
  map = false,
  onMove,
  onLink,
  onRemove,
  onAddOperator,
  onSelect,
  onPoint,
  menu,
  insets,
}: WorkflowCanvasProps & { insets: Insets }) {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme);
  const { screenToFlowPosition, fitView, getNodes, getNodesBounds, getViewport, setViewport } = useReactFlow();
  // Panels float over the canvas: what is fitted or brought into view goes in the part that no docked panel covers.
  const padding = useMemo(() => {
    const px = (inset: number): `${number}px` => `${inset + fitGap}px`;
    return { top: px(insets.top), right: px(insets.right), bottom: px(insets.bottom), left: px(insets.left) };
  }, [insets]);
  // The whole workflow is fitted in when the canvas is first drawn, around what the panels covered then. The options
  // stay one object: whenever React Flow is given new ones, it puts them over those of a fit already asked for, such
  // as the one that brings a selected operator into view, and fits the whole workflow instead.
  const [firstFit] = useState(() => ({ maxZoom: 1, padding }));
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // The canvas keeps its own copy of what is on it, which it moves while something is dragged. Whatever else
  // changes in the workflow, by this user or another, is taken over here. What the canvas itself knows of a node
  // stays: its measured size, without which it is not drawn, and whether it is selected or being dragged.
  useEffect(() => {
    setNodes(current => {
      const drawn = new Map(current.map(node => [node.id, node]));
      const placed = (id: string, position: Point) => {
        const node = drawn.get(id);
        return { ...node, id, position: node?.dragging ? node.position : position };
      };
      const comments = content.commentBoxes.map((box): CommentNodeType => ({
        ...placed(box.commentBoxID, box.commentBoxPosition),
        type: "comment",
        ariaLabel: `Comment by ${box.comments.at(0)?.creatorName ?? "nobody"}`,
        data: { comments: box.comments },
      }));
      const draft: CommentNodeType[] = draftComment
        ? [
            {
              id: draftId,
              type: "comment",
              position: draftComment,
              selectable: false,
              draggable: false,
              data: { comments: [] },
            },
          ]
        : [];
      const operators = content.operators.map((operator): OperatorNodeType => ({
        ...placed(operator.operatorID, content.operatorPositions[operator.operatorID] ?? { x: 0, y: 0 }),
        type: "operator",
        // What assistive technology calls the operator: React Flow makes each one a group.
        ariaLabel: operator.customDisplayName,
        data: {
          operator,
          typeName: typeNames[operator.operatorType] ?? operator.operatorType,
          problem: problems[operator.operatorID],
          progress: progress[operator.operatorID],
          selectedBy: collaborators.filter(({ selection }) => selection.includes(operator.operatorID)),
          mark: marks?.operators[operator.operatorID],
        },
      }));
      // Notes lie under the operators.
      return [...comments, ...draft, ...operators];
    });
  }, [content, draftComment, typeNames, problems, progress, collaborators, marks, setNodes]);

  useEffect(() => {
    const names = new Map(content.operators.map(operator => [operator.operatorID, operator.customDisplayName]));
    setEdges(current => {
      const selected = new Set(current.filter(edge => edge.selected).map(edge => edge.id));
      return content.links.map(link => ({
        id: link.linkID,
        // What assistive technology calls the link, which would otherwise be the ids of its operators.
        ariaLabel: `Link from ${names.get(link.source.operatorID)} to ${names.get(link.target.operatorID)}`,
        source: link.source.operatorID,
        sourceHandle: link.source.portID,
        target: link.target.operatorID,
        targetHandle: link.target.portID,
        selected: selected.has(link.linkID),
        ...linkLook(marks?.links[link.linkID]),
      }));
    });
  }, [content.links, content.operators, marks, setEdges]);

  // React Flow reports the selection again whenever this function is a new one, so it is always the same one,
  // and it tells the editor only of a selection that differs from the last.
  const selection = useRef("");
  const report = useRef(onSelect);
  useEffect(() => {
    report.current = onSelect;
  });
  const handleSelectionChange = useCallback<OnSelectionChangeFunc>(({ nodes: selectedNodes, edges: selectedEdges }) => {
    const selected = { ...elementsOf(selectedNodes), links: selectedEdges.map(edge => edge.id) };
    const key = JSON.stringify(selected);
    if (key === selection.current) return;
    selection.current = key;
    report.current?.(selected);
  }, []);

  /** Selects exactly these nodes, and these links. */
  const select = useCallback(
    (nodeIds: Set<string>, linkIds = new Set<string>()) => {
      setNodes(current => current.map(node => ({ ...node, selected: nodeIds.has(node.id) })));
      setEdges(current => current.map(edge => ({ ...edge, selected: linkIds.has(edge.id) })));
    },
    [setNodes, setEdges]
  );

  const store = useStoreApi<CanvasNode>();
  /**
   * Whether these nodes are all on the screen already, where no docked panel covers them. It reads the canvas's size
   * as it is when asked.
   */
  const inView = useCallback(
    (ids: string[]) => {
      const { width, height } = store.getState();
      const bounds = getNodesBounds(ids);
      const { x, y, zoom } = getViewport();
      // The part of the screen that is free, in the canvas's own coordinates.
      const [left, top] = [(insets.left - x) / zoom, (insets.top - y) / zoom];
      const [right, bottom] = [(width - insets.right - x) / zoom, (height - insets.bottom - y) / zoom];
      return (
        bounds.x >= left && bounds.y >= top && bounds.x + bounds.width <= right && bounds.y + bounds.height <= bottom
      );
    },
    [store, getNodesBounds, getViewport, insets]
  );

  // What is to be shown becomes what is selected, and is brought into view if it is not. Only a change of what is
  // to be shown does this: a panel that opens or closes after it reselects nothing.
  const reveal = useRef<(ids: string[]) => void>(undefined);
  useEffect(() => {
    reveal.current = ids => {
      if (ids.length > 0 && !inView(ids)) {
        void fitView({ nodes: ids.map(id => ({ id })), maxZoom: 1, duration: 300, padding });
      }
    };
  });
  const shownKey = shown?.join();
  useEffect(() => {
    if (shownKey === undefined) return;
    const ids = shownKey === "" ? [] : shownKey.split(",");
    select(new Set(ids));
    reveal.current?.(ids);
  }, [shownKey, select]);

  const [target, setTarget] = useState<CanvasTarget>();
  const placeOf = (event: MouseEvent | PointerEvent | DragEvent) =>
    screenToFlowPosition({ x: event.clientX, y: event.clientY });
  /** A right-click on a node acts on the selection: on the node alone, unless it is selected already. */
  function openOnNode(event: MouseEvent, id: string, isLink = false) {
    const node = isLink ? edges.find(edge => edge.id === id) : nodes.find(each => each.id === id);
    if (!node?.selected) select(isLink ? new Set() : new Set([id]), isLink ? new Set([id]) : new Set());
    setTarget({ at: placeOf(event), onSelection: true });
  }
  function openOnCanvas(event: MouseEvent | globalThis.MouseEvent) {
    select(new Set());
    setTarget({ at: screenToFlowPosition({ x: event.clientX, y: event.clientY }), onSelection: false });
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select(
        new Set(nodes.filter(node => node.selectable !== false).map(node => node.id)),
        new Set(edges.map(edge => edge.id))
      );
    }
    if (event.key === "Escape") select(new Set());
  }

  // When the canvas changes size, or a panel is docked over it, as when the properties of what was selected open,
  // what is selected stays in view: the canvas slides just as far as it must, at the same zoom.
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  useEffect(() => {
    const selected = getNodes().filter(node => node.selected);
    if (selected.length === 0) return;
    const bounds = getNodesBounds(selected);
    const { x, y, zoom } = getViewport();
    const shift = (from: number, to: number, start: number, end: number) =>
      from < start || to - from > end - start ? start - from : to > end ? end - to : 0;
    const [dx, dy] = [
      shift(
        bounds.x * zoom + x,
        (bounds.x + bounds.width) * zoom + x,
        insets.left + slideGap,
        width - insets.right - slideGap
      ),
      shift(
        bounds.y * zoom + y,
        (bounds.y + bounds.height) * zoom + y,
        insets.top + slideGap,
        height - insets.bottom - slideGap
      ),
    ];
    if (dx !== 0 || dy !== 0) void setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 200 });
  }, [width, height, insets, getNodes, getNodesBounds, getViewport, setViewport]);

  const pointedAt = useRef(0);
  function handlePointerMove(event: PointerEvent) {
    if (!onPoint || event.timeStamp - pointedAt.current < pointIntervalMs) return;
    pointedAt.current = event.timeStamp;
    onPoint(placeOf(event));
  }

  function handleDrop(event: DragEvent) {
    const operatorType = event.dataTransfer.getData(operatorDragType);
    if (!operatorType) return;
    event.preventDefault();
    onAddOperator?.(operatorType, placeOf(event));
  }

  return (
    // Not modal: the page around the menu stays as it is, and an item may send the keyboard elsewhere.
    <ContextMenu
      modal={false}
      onOpenChange={open => !open && setTarget(undefined)}>
      <ContextMenuTrigger
        asChild
        disabled={!menu}>
        <ReactFlow
          aria-label="Workflow canvas"
          // The canvas takes the keyboard when it is clicked, so that its keys work on what is selected there.
          tabIndex={-1}
          className="outline-none"
          colorMode={theme}
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(_, __, dragged) =>
            onMove?.(Object.fromEntries(dragged.map(node => [node.id, node.position])))
          }
          isValidConnection={connection => linkProblem(content, ...portsOf(connection)) === undefined}
          onConnect={connection => {
            const [source, target] = portsOf(connection);
            onLink?.({ linkID: newLinkId(), source, target });
          }}
          onDelete={({ nodes: deleted, edges: links }) =>
            onRemove?.({ ...elementsOf(deleted), links: links.map(edge => edge.id) })
          }
          onSelectionChange={handleSelectionChange}
          onNodeContextMenu={(event, node) => openOnNode(event, node.id)}
          onEdgeContextMenu={(event, edge) => openOnNode(event, edge.id, true)}
          onSelectionContextMenu={event => setTarget({ at: placeOf(event), onSelection: true })}
          onPaneContextMenu={openOnCanvas}
          onKeyDown={handleKeyDown}
          onDragOver={event => event.preventDefault()}
          onDrop={handleDrop}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => onPoint?.(undefined)}
          fitView
          fitViewOptions={firstFit}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          // A large workflow fits a phone's screen too.
          minZoom={0.2}
          // React Flow's own note in the corner would lie over the canvas.
          proOptions={{ hideAttribution: true }}>
          <Background />
          {/* The controls and the map stand in the corner the panels leave free, beside a docked one. */}
          <Controls
            showInteractive={false}
            position="bottom-right"
            orientation="horizontal"
            fitViewOptions={{ maxZoom: 1, padding }}
            style={{ marginRight: insets.right + controlGap, marginBottom: insets.bottom + controlGap }}
          />
          {map && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              // Above the controls.
              style={{ marginRight: insets.right + controlGap, marginBottom: insets.bottom + 4 * controlGap }}
            />
          )}
          {/* Drawn in the canvas's own coordinates, so a pointer is over the same operator for everyone. */}
          <ViewportPortal>
            {collaborators.map(
              collaborator =>
                collaborator.pointer && (
                  <div
                    key={collaborator.clientId}
                    role="img"
                    aria-label={`Pointer of ${collaborator.name}`}
                    className={cn(
                      "pointer-events-none absolute top-0 left-0 z-10 flex items-start transition-transform duration-75",
                      presenceClassNames(collaborator).text
                    )}
                    style={{ transform: `translate(${collaborator.pointer.x}px, ${collaborator.pointer.y}px)` }}>
                    <MousePointer2Icon className="size-4 fill-current" />
                    <span
                      className={cn(
                        "ml-1 rounded-sm px-1 text-xs text-primary-foreground",
                        presenceClassNames(collaborator).background
                      )}>
                      {collaborator.name}
                    </span>
                  </div>
                )
            )}
          </ViewportPortal>
        </ReactFlow>
      </ContextMenuTrigger>
      {menu && target && (
        <ContextMenuContent
          className="w-56"
          // An item that opened something to type in, such as a new comment, keeps the keyboard there.
          onCloseAutoFocus={event => {
            if (document.activeElement?.closest("input, textarea, [contenteditable]")) event.preventDefault();
          }}>
          {menu(target)}
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

/** The operators and the comment boxes among some nodes, by their ids. */
function elementsOf(nodes: { id: string; type?: string }[]): Omit<Selection, "links"> {
  return {
    operators: nodes.filter(node => node.type === "operator").map(node => node.id),
    commentBoxes: nodes.filter(node => node.type === "comment" && node.id !== draftId).map(node => node.id),
  };
}

/** The two ends of a link the canvas proposes: React Flow names an operator's port its "handle". */
function portsOf({ source, sourceHandle, target, targetHandle }: Connection | Edge): [PortRef, PortRef] {
  return [
    { operatorID: source, portID: sourceHandle ?? "" },
    { operatorID: target, portID: targetHandle ?? "" },
  ];
}
