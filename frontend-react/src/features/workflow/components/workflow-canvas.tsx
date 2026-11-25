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
  type NodeChange,
  type OnSelectionChangeFunc,
  ReactFlow,
  type ReactFlowState,
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
  type FocusEvent,
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
import type { ResourceScope } from "@/components/resource/api";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { OperatorProgress, OperatorResult } from "@/lib/execution/client";
import type { ResourcePath } from "@/lib/resource-path";
import { currentTheme, subscribeToTheme } from "@/lib/theme";
import {
  type CardChips,
  drawnPlaces,
  keptPlaces,
  operatorCard,
  resourceChipPlaces,
  resultChip,
  resultChipPlaces,
  roomFor,
  rowSpread,
  spread,
} from "@/lib/workflow/canvas-geometry";
import type { Mark, Marks } from "@/lib/workflow/diff";
import type { ElementIds, OperatorPatch } from "@/lib/workflow/document";
import { linkProblem } from "@/lib/workflow/links";
import type { Link, Operator, Point, PortRef, WorkflowContent } from "@/lib/workflow/model";
import type { Collaborator } from "@/lib/workflow/room";
import { newLinkId, type OperatorSchema } from "@/lib/workflow/operator-schema";
import { resourcesOf } from "@/lib/workflow/resources";
import { typing } from "../keys";
import { operatorDragType } from "../operator-drag";
import { operatorName, typeName } from "../operator-name";
import { presenceClassNames } from "../presence";
import { CardCanvasContext, type CardPart, cardPartId, resourcesHandle } from "./card-canvas";
import { CommentNode, type CommentNodeType } from "./comment-node";
import { OperatorNode, type OperatorNodeType } from "./operator-node";
import { ResourceChipNode, type ResourceChipNodeType } from "./resource-chip-node";
import { ResultChipNode, type ResultChipNodeType } from "./result-chip-node";

/** What is selected on the canvas. */
export type Selection = Required<ElementIds>;

/** Where the canvas was right-clicked: on what is selected, which the click selects if it was not, or on nothing. */
export interface CanvasTarget {
  /** The place on the canvas. */
  at: Point;
  onSelection: boolean;
}

/** How much each operator's card says: its settings in one line, or every setting on a line of its own. */
export type CardDensity = "compact" | "detailed";

/** Executing the workflow up to an operator, which another feature does: why it cannot be done now, or how to start it. */
export interface ExecutionUpTo {
  /** Why the workflow cannot be executed up to the operator now. */
  problem?: string;
  start: () => void;
}

export interface WorkflowCanvasProps {
  content: WorkflowContent;
  /** Each operator type the backend offers, by its name: what an operator's card calls its type and its settings. */
  schemas: Map<string, OperatorSchema>;
  /** How much each card says; compact, the settings in one line, unless the viewer chose otherwise. */
  density?: CardDensity;
  /** Why an operator cannot be executed as it is, by its id. */
  problems?: Record<string, string>;
  /** What each operator is doing in the execution being shown, by its id. */
  progress?: Record<string, OperatorProgress>;
  /** What the execution shown kept of each operator's output, by the operator's id. */
  results?: Record<string, OperatorResult>;
  /**
   * Whether each card has its chips around it, each joined to it by a dashed line: above it, the versions of the
   * datasets and models its operator reads, and under it, the result it kept. Shown, unless the viewer chose otherwise.
   */
  chips?: boolean;
  /**
   * Whose datasets and models a chip looks up once it is opened: those the user may read, or, for someone who is not
   * signed in, as the hub shows a workflow to anyone, the public ones.
   */
  resourceScope?: ResourceScope;
  /** Shows the result an operator kept, as a click on its chip asks. */
  onShowResult?: (operatorId: string) => void;
  /** The other people editing the workflow: the canvas shows their pointers, and each operator who has it selected. */
  collaborators?: Collaborator[];
  /**
   * The operators that someone else holds, editing them in their cards, each with whoever holds it (holds.ts). Each
   * card says who is editing it, and until they are done, its eye waits for them, its pencil opens it only to read,
   * and Delete leaves it: nothing here changes it but where it stands and its links. A hold stops changing, never
   * reading.
   */
  held?: ReadonlyMap<string, Collaborator>;
  /**
   * The operators to select and bring into view: the one this user has just added, or what someone else has
   * selected while this user follows them.
   */
  shown?: string[];
  /** A canvas that is only looked at: nothing on it can be moved, linked, removed or changed. */
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
  /** Changes an operator's name, or one of its switches, as the eye on its card does. */
  onPatch?: (operatorId: string, patch: OperatorPatch) => void;
  /**
   * The operator whose card is open, its settings to edit in it, or to read on a canvas that is only looked at. One
   * card is open at a time.
   */
  editing?: string;
  /** Whether the operator whose card is open was added just now: its card gives the first of its settings the keyboard. */
  justAdded?: boolean;
  /**
   * Whether the card that is open was opened only to read, as a card someone else held when it was opened is: nothing
   * in it changes its operator, though its code, which no one holds, opens to type in. It stays so until it is opened
   * again.
   */
  openToRead?: boolean;
  /**
   * Opens an operator's card, as its pencil, a double click or Enter on it does, or closes the card that is open, as
   * its Done button, Escape in it or on its operator, or a click on the empty canvas does. Without it, no card opens.
   */
  onEdit?: (operatorId: string | undefined) => void;
  /** What the open card holds under its name: the operator's settings. */
  card?: (operator: Operator) => ReactNode;
  /** Whether the workflow can be executed up to an operator now, and how. Without it, no card offers to. */
  executeUpTo?: (operatorId: string) => ExecutionUpTo;
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
 * The room kept around the workflow when it is fitted into the canvas, besides what the panels cover and what the
 * chips around the cards take. What else stands outside the cards, as who has one selected above it, stays on the
 * screen in it.
 */
const fitGap = 64;
/** The room between the canvas's own controls and its edge, or a panel docked there. */
const controlGap = 12;
/** The room kept between what is selected and a panel, when the canvas slides it out from under one. */
const slideGap = 32;

const nodeTypes = { operator: OperatorNode, comment: CommentNode, resource: ResourceChipNode, result: ResultChipNode };
type CanvasNode = OperatorNodeType | CommentNodeType | ResourceChipNodeType | ResultChipNodeType;
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
/**
 * What a chip is on the canvas: no part of the workflow, so nothing selects, moves, removes or links it. The keyboard
 * goes to the chip's own button, after its card's, not to a node around it, which React Flow's words of how a node is
 * selected and moved would describe. It takes the pointer all the same, which React Flow gives no node that cannot be
 * selected or moved.
 */
const chipNode = {
  selectable: false,
  draggable: false,
  deletable: false,
  connectable: false,
  focusable: false,
  domAttributes: { "aria-roledescription": undefined, "aria-describedby": undefined },
  style: { pointerEvents: "all" },
} as const;
/**
 * The line from a chip to its card, for the eye alone: dashed and thin, without an arrow, in the links' color, and
 * nothing to select or remove. What a chip shows flows into an operator or out of it, but is no step of the workflow,
 * and whoever comes with the keyboard finds each chip after its card. It lies under its card, which covers the part of
 * it that crosses the card, as the line to an open card's result does: the open card is wider than the place of its
 * results. React Flow lays a line that ends on a chip as high as the chip, one above the chip's card; the -1 brings it
 * down to the card's own height, where the card, drawn after every line, lies over it.
 */
const chipLine = {
  selectable: false,
  focusable: false,
  deletable: false,
  reconnectable: false,
  zIndex: -1,
  domAttributes: { "aria-hidden": true },
  style: { stroke: linkColors.none, strokeWidth: 1.25, strokeDasharray: "4 4" },
};
/** Where a card's chips stand from, as React Flow places a node that moves with another: from the card's corner. */
const origin = { x: 0, y: 0 };
/** The node of the comment that is being written, which is not a comment box yet. */
const draftId = "draft-comment";
/** How high the card open for editing lies: over every other, as React Flow lifts a selected one 1000 above the rest. */
const openCardZ = 2000;
/** The parts of a card that describe its operator, after what React Flow says of every node, in the order they show. */
const describingParts: CardPart[] = ["held", "left-out", "summary", "settings", "problem", "execution"];
// One object for "none", so that a canvas without problems or progress is not given a new one on every render.
const none = {};
const nobody: Collaborator[] = [];
const nothingHeld: ReadonlyMap<string, Collaborator> = new Map();

/**
 * The canvas of a workflow: its operators and the links between them, to look at or to edit, and around each operator's
 * card, its chips: above it, the versions of the datasets and models it reads, and under it, the result it kept. Where
 * panels float over it, it is drawn once it knows what they cover, so that the workflow is fitted into the rest from
 * the start.
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
  schemas,
  density = "compact",
  problems = none,
  progress = none,
  results = none,
  chips = true,
  resourceScope,
  onShowResult,
  collaborators = nobody,
  held = nothingHeld,
  shown,
  readOnly = false,
  draftComment,
  marks,
  map = false,
  onMove,
  onLink,
  onRemove,
  onPatch,
  editing,
  justAdded,
  openToRead,
  onEdit,
  card,
  executeUpTo,
  onAddOperator,
  onSelect,
  onPoint,
  menu,
  insets,
}: WorkflowCanvasProps & { insets: Insets }) {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme);
  const cards = useMemo(
    () => ({
      density,
      readOnly,
      onPatch,
      editing,
      justAdded,
      openToRead,
      onEdit,
      card,
      executeUpTo,
      resourceScope,
      onShowResult,
    }),
    [density, readOnly, onPatch, editing, justAdded, openToRead, onEdit, card, executeUpTo, resourceScope, onShowResult]
  );
  // React Flow describes every node to whoever comes to it with the keyboard, under this id: how it is selected, moved
  // and removed.
  const nodeDescription = `react-flow__node-desc-${useStore(state => state.rfId)}`;
  const { screenToFlowPosition, fitView, getNodes, getNodesBounds, getViewport, setViewport } = useReactFlow();
  // What stands around each card, unless the viewer hides it: the versions its operator reads, and the result it kept.
  // The rows, the open card and the fit make room for it.
  const around = useMemo(
    (): Record<string, Around> => (chips ? aroundOf(content, schemas, results) : none),
    [chips, content, schemas, results]
  );
  const { counts, most } = useMemo(() => chipCounts(around), [around]);
  const reach = chipReach(most);
  // Panels float over the canvas: what is fitted or brought into view goes in the part that no docked panel covers,
  // with the room the chips take out of the cards.
  const padding = useMemo(() => {
    const px = (inset: number): `${number}px` => `${inset + fitGap}px`;
    return {
      top: px(insets.top + reach.top),
      right: px(insets.right + reach.right),
      bottom: px(insets.bottom + reach.bottom),
      left: px(insets.left),
    };
  }, [insets, reach.top, reach.right, reach.bottom]);
  const fitted = useMemo(() => fittedOf(content), [content]);
  // The whole workflow is fitted in when the canvas is first drawn, around what the panels covered then. The options
  // stay one object: whenever React Flow is given new ones, it puts them over those of a fit already asked for, such
  // as the one that brings a selected operator into view, and fits the whole workflow instead.
  const [firstFit] = useState(() => ({ maxZoom: 1, padding, ...fitted }));
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // The cards as React Flow measured them. The rows are drawn as far apart as the tallest closed card needs, with the
  // chips around it, and while a card is open, the cards under it are drawn lower to make room for it
  // (canvas-geometry.ts). That is this viewer's drawing only: the workflow keeps its places, and every place the canvas
  // tells of is one it keeps (keptAt).
  const heights = useStore(cardHeightsOf, sameNumbers);
  const tallest = Math.max(0, ...Object.entries(heights).flatMap(([id, height]) => (id === editing ? [] : [height])));
  const openWidth = useStore(state => (editing === undefined ? 0 : state.nodeLookup.get(editing)?.measured.width) ?? 0);
  const openHeight = editing === undefined ? 0 : (heights[editing] ?? 0);
  const k = rowSpread(tallest, most);
  const openCard = useMemo(
    () => (editing !== undefined && openHeight > 0 ? { id: editing, width: openWidth, height: openHeight } : undefined),
    [editing, openWidth, openHeight]
  );
  const drawn = useMemo(() => spread(placesOf(content, draftComment), k), [content, draftComment, k]);
  const room = useMemo(() => (openCard ? roomFor(drawn, openCard, counts) : {}), [drawn, openCard, counts]);
  /** The place the workflow keeps for one drawn at `at`. */
  const keptAt = (at: Point) => keptPlaces({ at }, k, drawn, openCard, counts).at;

  // The canvas keeps its own copy of what is on it, which it moves while something is dragged. Whatever else
  // changes in the workflow, by this user or another, is taken over here. What the canvas itself knows of a node
  // stays: its measured size, without which it is not drawn, and whether it is selected or being dragged.
  useEffect(() => {
    setNodes(current => {
      const before = new Map(current.map(node => [node.id, node]));
      const placed = (id: string) => {
        const node = before.get(id);
        const { x, y } = drawn[id] ?? { x: 0, y: 0 };
        return { ...node, id, position: node?.dragging ? node.position : { x, y: y + (room[id] ?? 0) } };
      };
      const comments = content.commentBoxes.map((box): CommentNodeType => ({
        ...placed(box.commentBoxID),
        type: "comment",
        ariaLabel: `Comment by ${box.comments.at(0)?.creatorName ?? "nobody"}`,
        data: { comments: box.comments },
      }));
      /** A chip of a card, which stands where it does from the card: React Flow moves it with the card. */
      const chipped = (id: string, card: string, position: Point) => ({
        ...before.get(id),
        ...chipNode,
        id,
        parentId: card,
        position,
      });
      const draft: CommentNodeType[] = draftComment
        ? [
            {
              ...placed(draftId),
              type: "comment",
              selectable: false,
              draggable: false,
              data: { comments: [] },
            },
          ]
        : [];
      const operators = content.operators.flatMap((operator): CanvasNode[] => {
        const id = operator.operatorID;
        const name = operatorName(operator, schemas);
        const heldBy = held.get(id);
        const { resources = [], result } = around[id] ?? {};
        // Above the card as it is drawn, open or closed, and under it, as tall as it is drawn.
        const size = id === openCard?.id ? openCard : operatorCard;
        const reads = resourceChipPlaces(origin, size, resources.length).map(
          (position, index): ResourceChipNodeType => ({
            ...chipped(resourceChipId(id, index), id, position),
            type: "resource",
            data: { path: resources[index] },
          })
        );
        const kept: ResultChipNodeType[] = result
          ? resultChipPlaces(origin, heights[id] ?? operatorCard.height, 1).map(position => ({
              ...chipped(resultChipId(id), id, position),
              type: "result",
              data: { operatorId: id, name, result },
            }))
          : [];
        const cardNode: OperatorNodeType = {
          ...placed(id),
          type: "operator",
          // The card follows what React Flow's node around it does, such as taking the keyboard for it.
          className: "group/node",
          // What assistive technology calls the operator, which React Flow makes a group, and what describes it.
          ariaLabel: name,
          domAttributes: {
            "aria-describedby": [nodeDescription, ...describingParts.map(part => cardPartId(id, part))].join(" "),
          },
          zIndex: id === editing ? openCardZ : undefined,
          // Delete leaves what someone else is editing, and removes the rest of what is selected.
          deletable: heldBy === undefined,
          data: {
            operator,
            name,
            typeName: typeName(operator.operatorType, schemas),
            schema: schemas.get(operator.operatorType),
            problem: problems[id],
            progress: progress[id],
            selectedBy: collaborators.filter(({ selection }) => selection.includes(id)),
            heldBy,
            mark: marks?.operators[id],
          },
        };
        // Each card's chips come after it, as the keyboard comes to them.
        return [cardNode, ...reads, ...kept];
      });
      // Notes lie under the operators.
      return [...comments, ...draft, ...operators];
    });
  }, [
    content,
    draftComment,
    drawn,
    room,
    around,
    openCard,
    heights,
    schemas,
    nodeDescription,
    editing,
    problems,
    progress,
    collaborators,
    held,
    marks,
    setNodes,
  ]);

  useEffect(() => {
    const names = new Map(content.operators.map(operator => [operator.operatorID, operatorName(operator, schemas)]));
    setEdges(current => {
      const selected = new Set(current.filter(edge => edge.selected).map(edge => edge.id));
      const links = content.links.map(link => ({
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
      // The chips' lines: straight down from each version to the card that reads it, and from the card's output to
      // the result it kept.
      const lines = content.operators.flatMap((operator): Edge[] => {
        const id = operator.operatorID;
        const { resources = [], result } = around[id] ?? {};
        const output = operator.outputPorts.at(0)?.portID;
        return [
          ...resources.map((_, index) => ({
            ...chipLine,
            id: `${resourceChipId(id, index)}:line`,
            type: "straight",
            source: resourceChipId(id, index),
            target: id,
            targetHandle: resourcesHandle,
          })),
          ...(result && output
            ? [
                {
                  ...chipLine,
                  id: `${resultChipId(id)}:line`,
                  source: id,
                  sourceHandle: output,
                  target: resultChipId(id),
                },
              ]
            : []),
        ];
      });
      return [...links, ...lines];
    });
  }, [content.links, content.operators, schemas, marks, around, setEdges]);

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

  /**
   * Slides the canvas just as far as it must, at the same zoom, for these nodes to be on the screen where no docked
   * panel covers them, the slide's gap clear of its edges, or, where they do not fit there, their top left corner. It
   * reads the canvas's size as it is when asked.
   */
  const slideToShow = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const { width, height } = store.getState();
      const bounds = getNodesBounds(ids);
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
    },
    [store, getNodesBounds, getViewport, setViewport, insets]
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
  /** Where an event happened on the canvas, as the workflow keeps places. */
  const placeOf = (event: MouseEvent | globalThis.MouseEvent | PointerEvent | DragEvent) =>
    keptAt(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  /** A right-click on a node acts on the selection: on the node alone, unless it is selected already. */
  function openOnNode(event: MouseEvent, id: string, isLink = false) {
    const node = isLink ? edges.find(edge => edge.id === id) : nodes.find(each => each.id === id);
    if (!node?.selected) select(isLink ? new Set() : new Set([id]), isLink ? new Set([id]) : new Set());
    setTarget({ at: placeOf(event), onSelection: true });
  }
  function openOnCanvas(event: MouseEvent | globalThis.MouseEvent) {
    select(new Set());
    setTarget({ at: placeOf(event), onSelection: false });
  }

  /**
   * Takes over what React Flow changed on the canvas, as when it removed what was deleted. A card that goes takes its
   * chips with it, which stand where they do from it, and which nothing deletes on their own.
   */
  function handleNodesChange(changes: NodeChange<CanvasNode>[]) {
    const gone = new Set(changes.flatMap(change => (change.type === "remove" ? [change.id] : [])));
    const theirs = nodes.flatMap(({ id, parentId }): NodeChange<CanvasNode>[] =>
      parentId !== undefined && gone.has(parentId) ? [{ type: "remove", id }] : []
    );
    onNodesChange([...changes, ...theirs]);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (typing(event.target)) return;
    const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select(
        new Set(nodes.filter(node => node.selectable !== false).map(node => node.id)),
        new Set(edges.filter(edge => edge.selectable !== false).map(edge => edge.id))
      );
    }
    if (event.key === "Escape") select(new Set());
    // Enter on an operator selects it, as React Flow has it, and opens its card, or gives its open card the keyboard.
    const operatorId = operatorOf(event.target);
    if (event.key !== "Enter" || modified || operatorId === undefined) return;
    if (operatorId === editing) document.getElementById(cardPartId(operatorId, "properties"))?.focus();
    else onEdit?.(operatorId);
  }

  /**
   * Escape on the operator whose card is open closes the card, as Escape in the card does: it is taken before React
   * Flow takes it for unselecting the operator, which would also take the keyboard from it.
   */
  function handleKeyDownCapture(event: KeyboardEvent) {
    if (event.key !== "Escape" || editing === undefined || operatorOf(event.target) !== editing) return;
    event.stopPropagation();
    onEdit?.(undefined);
  }

  // When the canvas changes size, or a panel is docked over it, as when an execution's results open, or the card
  // open for editing grows, what is selected stays in view, and so does what has the keyboard, as the chip of a result
  // that was just shown: the canvas slides just as far as it must, at the same zoom.
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  useEffect(() => {
    const keyboard = keyboardNodeOf(store.getState().domNode);
    slideToShow([...getNodes().flatMap(node => (node.selected ? [node.id] : [])), ...(keyboard ? [keyboard] : [])]);
  }, [width, height, openHeight, store, getNodes, slideToShow]);

  /**
   * A chip that the keyboard comes to is brought into view, as React Flow brings an operator that it gives the keyboard
   * to: it gives none to a chip, and the canvas does not scroll to what has it.
   */
  function handleFocus({ target }: FocusEvent) {
    if (!(target instanceof Element) || !target.matches(":focus-visible")) return;
    const id = target.closest<HTMLElement>(".react-flow__node")?.dataset.id;
    if (id !== undefined && getNodes().find(node => node.id === id)?.focusable === false) slideToShow([id]);
  }

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
    <CardCanvasContext value={cards}>
      {/* Not modal: the page around the menu stays as it is, and an item may send the keyboard elsewhere. */}
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
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            // What is dragged is kept where it was dropped, as the workflow keeps places: without the room or the spread.
            onNodeDragStop={(_, __, dragged) =>
              onMove?.(
                keptPlaces(
                  Object.fromEntries(dragged.map(node => [node.id, node.position])),
                  k,
                  drawn,
                  openCard,
                  counts
                )
              )
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
            onNodeDoubleClick={(_, node) => node.type === "operator" && onEdit?.(node.id)}
            // A double click opens a card: it zooms nothing, wherever it lands.
            zoomOnDoubleClick={false}
            onPaneClick={() => editing !== undefined && onEdit?.(undefined)}
            onNodeContextMenu={(event, node) => openOnNode(event, node.id)}
            onEdgeContextMenu={(event, edge) => openOnNode(event, edge.id, true)}
            onSelectionContextMenu={event => setTarget({ at: placeOf(event), onSelection: true })}
            onPaneContextMenu={openOnCanvas}
            onKeyDown={handleKeyDown}
            onKeyDownCapture={handleKeyDownCapture}
            onFocus={handleFocus}
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
              fitViewOptions={{ maxZoom: 1, padding, ...fitted }}
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
              {collaborators.map(collaborator => {
                if (!collaborator.pointer) return null;
                // Told as the workflow keeps places, and drawn where this viewer draws what lies there: with the rows
                // as far apart, and the room the open card takes.
                const { x, y } = drawnPlaces({ at: collaborator.pointer }, k, drawn, openCard, counts).at;
                return (
                  <div
                    key={collaborator.clientId}
                    role="img"
                    aria-label={`Pointer of ${collaborator.name}`}
                    className={cn(
                      "pointer-events-none absolute top-0 left-0 z-10 flex items-start transition-transform duration-75",
                      presenceClassNames(collaborator).text
                    )}
                    style={{ transform: `translate(${x}px, ${y}px)` }}>
                    <MousePointer2Icon className="size-4 fill-current" />
                    <span className={cn("ml-1 rounded-sm px-1 text-xs", presenceClassNames(collaborator).label)}>
                      {collaborator.name}
                    </span>
                  </div>
                );
              })}
            </ViewportPortal>
          </ReactFlow>
        </ContextMenuTrigger>
        {menu && target && (
          <ContextMenuContent
            className="w-56"
            // An item that opened something to type in, such as a new comment, keeps the keyboard there.
            onCloseAutoFocus={event => {
              if (typing(document.activeElement)) event.preventDefault();
            }}>
            {menu(target)}
          </ContextMenuContent>
        )}
      </ContextMenu>
    </CardCanvasContext>
  );
}

/** What stands around a card: the versions its operator reads, and what the execution shown kept of its output. */
interface Around {
  resources: ResourcePath[];
  result?: OperatorResult;
}

/** What stands around each card, by operator, of those that have anything around them. */
function aroundOf(
  content: WorkflowContent,
  schemas: Map<string, OperatorSchema>,
  results: Record<string, OperatorResult>
): Record<string, Around> {
  const around: Record<string, Around> = {};
  for (const operator of content.operators) {
    const schema = schemas.get(operator.operatorType);
    const resources = schema ? resourcesOf(operator, schema) : [];
    const result = results[operator.operatorID];
    if (resources.length > 0 || result) around[operator.operatorID] = { resources, ...(result && { result }) };
  }
  return around;
}

/** How many chips each card has, by operator, and the most that any card has of each kind, as the rows count them. */
function chipCounts(around: Record<string, Around>): { counts: Record<string, CardChips>; most: CardChips } {
  const counts = Object.fromEntries(
    Object.entries(around).map(([id, { resources, result }]) => [
      id,
      { resources: resources.length, results: result ? 1 : 0 },
    ])
  );
  const all = Object.values(counts);
  return {
    counts,
    most: {
      resources: Math.max(0, ...all.map(each => each.resources)),
      results: Math.max(0, ...all.map(each => each.results)),
    },
  };
}

/**
 * How far the most chips a card has reach out of it, beyond each of its edges: above it, the versions it reads, and
 * under it, its results, which also stand half a chip out of its right edge.
 */
function chipReach({ resources = 0, results = 0 }: CardChips) {
  const highest = resourceChipPlaces(origin, operatorCard, resources).at(-1);
  const below = resultChipPlaces(origin, 0, results);
  const [rightmost, lowest] = [below.at(0), below.at(-1)];
  return {
    top: highest ? -highest.y : 0,
    bottom: lowest ? lowest.y + resultChip.height : 0,
    right: rightmost ? rightmost.x + resultChip.width - operatorCard.width : 0,
  };
}

/**
 * What fitting the workflow into view fits: the workflow itself, its operators and its comment boxes, never the chips
 * around the cards, which the fit's room keeps on the screen. A workflow with nothing gives React Flow nothing to fit.
 */
function fittedOf(content: WorkflowContent): { nodes?: { id: string }[] } {
  const ids = [...content.operators.map(each => each.operatorID), ...content.commentBoxes.map(box => box.commentBoxID)];
  return ids.length > 0 ? { nodes: ids.map(id => ({ id })) } : {};
}

/** How tall each operator's card is drawn, by operator, once React Flow has measured it. */
function cardHeightsOf({ nodeLookup }: ReactFlowState): Record<string, number> {
  const heights: Record<string, number> = {};
  for (const node of nodeLookup.values()) {
    if (node.type === "operator" && node.measured.height) heights[node.id] = node.measured.height;
  }
  return heights;
}

/** Whether two records of numbers say the same, so that the canvas draws again only when one changed. */
function sameNumbers(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

/** The id of a chip of a version an operator reads, by its place among the versions its settings name. */
const resourceChipId = (operatorId: string, index: number) => `${operatorId}:resource:${index}`;

/** The id of the chip of the result an operator kept. */
const resultChipId = (operatorId: string) => `${operatorId}:result`;

/** Where the workflow keeps what the canvas draws: its operators, its comment boxes, and the comment being written. */
function placesOf(content: WorkflowContent, draftComment: Point | undefined): Record<string, Point> {
  return {
    ...Object.fromEntries(
      content.operators.map(({ operatorID }) => [operatorID, content.operatorPositions[operatorID] ?? { x: 0, y: 0 }])
    ),
    ...Object.fromEntries(content.commentBoxes.map(box => [box.commentBoxID, box.commentBoxPosition])),
    ...(draftComment && { [draftId]: draftComment }),
  };
}

/** The node of a canvas that has the keyboard, or that something in it has, as a chip's button does, by its id. */
function keyboardNodeOf(canvas: HTMLElement | null): string | undefined {
  const node = document.activeElement?.closest<HTMLElement>(".react-flow__node");
  return node && canvas?.contains(node) ? node.dataset.id : undefined;
}

/** The operator whose node on the canvas `target` is, as when the node has the keyboard. */
function operatorOf(target: EventTarget): string | undefined {
  return target instanceof HTMLElement && target.classList.contains("react-flow__node-operator")
    ? target.dataset.id
    : undefined;
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
