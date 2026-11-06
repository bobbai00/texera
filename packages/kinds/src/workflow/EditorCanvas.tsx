import { useQuery } from "@tanstack/react-query";
import { Button, useDark } from "@texera/ui";
import {
  addLink,
  addOperator,
  COLUMN,
  type Compilation,
  deleteLinks,
  deleteOperators,
  freeSpot,
  linkProblem,
  newOperator,
  type OperatorNode,
  type OperatorOverlay,
  toFlow,
} from "@texera/workflow-model";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type OnSelectionChangeParams,
  Panel,
  ReactFlow,
  useEdgesState,
  useStore as useFlowStore,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, X } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { operatorSchemasQuery } from "../queries";
import { useScope } from "../scope";
import { edgeOptions } from "../shell/canvas";
import { CanvasContext, type CanvasView, portKey } from "./canvas-view";
import { CanvasControls } from "./controls";
import { DensityToggle, spread, unspread, useRowSpread } from "./density";
import type { EditorStore } from "./editor";
import { useFollow, useFrame, useReframe } from "./framing";
import { nodeTypes } from "./OperatorNode";
import { OPERATOR_DRAG_TYPE, OperatorPalette } from "./OperatorPalette";
import { roomFor } from "./room";

const FIT_UP_TO = 60;
const EDITOR_VIEWPORT = { x: 40, y: 40, zoom: 1 };

/**
 * The editable canvas: every change goes through the editor store, which saves it. Operators
 * are added from a list that opens beside it and are edited in their cards. Needs a
 * ReactFlowProvider above.
 */
export function EditorCanvas({
  store,
  view,
  overlay,
  compilation,
  onRunTo,
  className,
}: {
  store: EditorStore;
  view: CanvasView;
  overlay?: Record<string, OperatorOverlay>;
  compilation?: Compilation;
  /** Runs the workflow up to an operator; without it, a card has no run button. */
  onRunTo?: (operatorID: string) => void;
  className?: string;
}) {
  const spec = useStore(store, s => s.spec);
  const positions = useStore(store, s => s.positions);
  const selected = useStore(store, s => s.selected);
  const readonly = useStore(store, s => s.readonly);
  const editing = useStore(view, s => s.editing);
  const density = useStore(view, s => s.density);
  const [fitOnOpen] = useState(() => store.getState().spec.operators.length <= FIT_UP_TO);
  // An empty workflow opens with the operators to choose from; one with operators shows them.
  const [paletteOpen, setPaletteOpen] = useState(
    () => !store.getState().readonly && store.getState().spec.operators.length === 0
  );
  const wrapper = useRef<HTMLDivElement>(null);
  const userMoved = useRef(false);
  const { screenToFlowPosition, setCenter, getViewport } = useReactFlow();
  const flowStore = useStoreApi();
  const frame = useFrame(view);
  const measured = useNodesInitialized();
  const dark = useDark();
  // Cards that say every setting are taller: the rows move apart so none lies on the next.
  const k = useRowSpread(editing);
  // Until the person has moved the canvas themselves, it is the app's to frame.
  const still = useCallback(() => fitOnOpen && !userMoved.current, [fitOnOpen]);
  useReframe(wrapper, frame, still);
  // The workflow is brought into view when it opens, and again when how much the cards say
  // changes how far it reaches, until the person has moved the canvas themselves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and on a change of density and of the spread it causes
  useEffect(() => {
    if (measured && fitOnOpen && !userMoved.current) void frame();
  }, [measured, density, k]);
  useFollow(view);
  // Escape closes the card that is open, wherever in it the person is.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") view.getState().edit(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, view]);
  // The card open for editing, as it is drawn: the cards under it make room for it.
  const openWidth = useFlowStore(s => (editing ? (s.nodeLookup.get(editing)?.measured.width ?? 0) : 0));
  const openHeight = useFlowStore(s => (editing ? (s.nodeLookup.get(editing)?.measured.height ?? 0) : 0));
  const drawn = useMemo(() => spread(positions, k), [positions, k]);
  const room = useMemo(
    () => (editing ? roomFor(drawn, { id: editing, width: openWidth, height: openHeight }) : {}),
    [drawn, editing, openWidth, openHeight]
  );
  const flow = useMemo(() => {
    const placed = Object.fromEntries(
      Object.entries(drawn).map(([id, p]) => [id, room[id] ? { x: p.x, y: p.y + room[id] } : p])
    );
    return toFlow(spec, placed, overlay);
  }, [spec, drawn, room, overlay]);
  const [nodes, setNodes, onNodesChange] = useNodesState<OperatorNode>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow.edges);
  const { data: schemas } = useQuery(operatorSchemasQuery(useScope()));
  const canvas = useMemo(
    () => ({ view, schemas, editor: store, compilation, run: readonly ? undefined : onRunTo }),
    [view, schemas, store, compilation, readonly, onRunTo]
  );

  // The store is the truth of the workflow; React Flow keeps what it measured, what is being
  // dragged and what is picked. The store's pick is put onto the canvas only when the store
  // changed it (an operator just added is picked): a pick made on the canvas is the canvas's
  // until it has told the store, and the two must not answer each other.
  const picked = useRef(selected);
  useEffect(() => {
    const told = picked.current !== selected;
    picked.current = selected;
    setNodes(previous => {
      const before = new Map(previous.map(n => [n.id, n]));
      return flow.nodes.map(n => {
        const p = before.get(n.id);
        const chosen = told || !p ? n.id === selected : p.selected;
        // The card open for editing lies over its neighbours while it is.
        const zIndex = n.id === editing ? 1000 : undefined;
        return p
          ? { ...p, data: n.data, position: p.dragging ? p.position : n.position, selected: chosen, zIndex }
          : { ...n, selected: chosen, zIndex };
      });
    });
    setEdges(previous => {
      const picked = new Set(previous.filter(e => e.selected).map(e => e.id));
      return flow.edges.map(e => ({ ...e, selected: picked.has(e.id) }));
    });
  }, [flow, selected, editing, setNodes, setEdges]);

  const edit = store.getState().edit;

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle) return;
      edit(cur =>
        addLink(
          cur,
          { operatorID: c.source, portID: c.sourceHandle ?? "" },
          { operatorID: c.target, portID: c.targetHandle ?? "" }
        )
      );
    },
    [edit]
  );
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      !linkProblem(
        store.getState().spec,
        { operatorID: c.source, portID: c.sourceHandle ?? "" },
        { operatorID: c.target, portID: c.targetHandle ?? "" }
      ),
    [store]
  );

  /** Puts a new operator of a type on the canvas, at a place on screen, and opens it. */
  const place = useCallback(
    (type: string, at: { x: number; y: number }) => {
      const schema = schemas?.get(type);
      if (!schema || store.getState().readonly) return undefined;
      const op = newOperator(schema);
      const spot = freeSpot(store.getState().positions, unspread(at, k));
      store.getState().move({ [op.operatorID]: spot });
      edit(cur => addOperator(cur, op));
      store.getState().select(op.operatorID);
      // A new operator is there to be set.
      view.getState().edit(op.operatorID);
      return spread({ at: spot }, k).at;
    },
    [schemas, store, edit, view, k]
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(OPERATOR_DRAG_TYPE);
      if (!type) return;
      e.preventDefault();
      place(type, screenToFlowPosition({ x: e.clientX - 124, y: e.clientY - 28 }));
    },
    [place, screenToFlowPosition]
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(OPERATOR_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  /** Adds an operator picked from the list: right of the one selected, else in the middle of what is on screen. */
  const addFromPalette = (type: string) => {
    const { positions: placed, selected: after } = store.getState();
    const anchor = after ? spread({ at: placed[after] ?? { x: 0, y: 0 } }, k).at : undefined;
    const { width, height } = flowStore.getState();
    const viewport = getViewport();
    const middle = {
      x: (width / 2 - viewport.x) / viewport.zoom - 124,
      y: (height / 2 - viewport.y) / viewport.zoom - 32,
    };
    const spot = place(type, anchor && after && placed[after] ? { x: anchor.x + COLUMN, y: anchor.y } : middle);
    if (spot)
      setTimeout(() => void setCenter(spot.x + 124, spot.y + 120, { zoom: getViewport().zoom, duration: 200 }), 60);
  };

  const onSelectionChange = useCallback(
    ({ nodes: chosen }: OnSelectionChangeParams) => {
      const id = chosen.length === 1 ? (chosen[0]?.id ?? null) : null;
      if (id !== store.getState().selected) store.getState().select(id);
    },
    [store]
  );

  return (
    <CanvasContext value={canvas}>
      <div className={className}>
        {paletteOpen && !readonly && (
          <aside className="w-60 shrink-0 border-r bg-sidebar" data-operator-palette-panel>
            <OperatorPalette onAdd={addFromPalette} />
          </aside>
        )}
        <div
          ref={wrapper}
          className="relative min-w-0 flex-1 bg-canvas"
          data-workflow-canvas
          data-editable={!readonly}
          data-density={density}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={edgeOptions}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={readonly ? undefined : onConnect}
            isValidConnection={isValidConnection}
            onNodeDragStop={(_, __, dragged) =>
              store
                .getState()
                .move(
                  Object.fromEntries(
                    dragged.map(n => [n.id, unspread({ x: n.position.x, y: n.position.y - (room[n.id] ?? 0) }, k)])
                  )
                )
            }
            onNodesDelete={deleted =>
              edit(cur =>
                deleteOperators(
                  cur,
                  deleted.map(n => n.id)
                )
              )
            }
            onEdgesDelete={deleted =>
              edit(cur =>
                deleteLinks(
                  cur,
                  deleted.map(e => e.id)
                )
              )
            }
            onSelectionChange={onSelectionChange}
            // A click on a card shows its result, when the execution on screen kept one.
            onNodeClick={(_, node) => {
              const port = node.data.results?.[0];
              if (port) view.getState().show(portKey(node.id, port));
            }}
            // A double click on a card opens it for editing, as its pencil does.
            onNodeDoubleClick={readonly ? undefined : (_, node) => view.getState().edit(node.id)}
            // A click on the empty canvas closes the card that is open.
            onPaneClick={() => view.getState().edit(null)}
            onMoveStart={event => {
              if (event) userMoved.current = true;
            }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodesDraggable={!readonly}
            nodesConnectable={!readonly}
            deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
            defaultViewport={EDITOR_VIEWPORT}
            minZoom={0.1}
            colorMode={dark ? "dark" : "light"}>
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
            <Panel position="top-left" className="flex items-center gap-2">
              {!readonly && (
                <Button
                  variant={paletteOpen ? "secondary" : "outline"}
                  size="sm"
                  className="bg-background shadow-xs"
                  onClick={() => setPaletteOpen(o => !o)}
                  aria-expanded={paletteOpen}
                  data-add-operator>
                  {paletteOpen ? <X /> : <Plus />} {paletteOpen ? "Close" : "Add operator"}
                </Button>
              )}
              <DensityToggle view={view} />
            </Panel>
            <CanvasControls view={view} />
          </ReactFlow>
        </div>
      </div>
    </CanvasContext>
  );
}
