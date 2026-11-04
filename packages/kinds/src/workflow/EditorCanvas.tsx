import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type OnSelectionChangeParams,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  addLink,
  addOperator,
  deleteLinks,
  deleteOperators,
  linkProblem,
  newOperator,
  type OperatorNode,
  type OperatorOverlay,
  toFlow,
} from "@texera/workflow-model";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { operatorSchemasQuery } from "../queries";
import type { EditorStore } from "./editor";
import { nodeTypes } from "./OperatorNode";
import { OPERATOR_DRAG_TYPE } from "./OperatorPalette";
import { defaultEdgeOptions } from "./WorkflowCanvas";

const EDITOR_FIT = { padding: 0.2, maxZoom: 1 };
const FIT_UP_TO = 60;
const EDITOR_VIEWPORT = { x: 40, y: 40, zoom: 1 };

/** The editable canvas: every change goes through the editor store, which saves it. Needs a ReactFlowProvider above. */
export function EditorCanvas({
  store,
  overlay,
  className,
}: {
  store: EditorStore;
  overlay?: Record<string, OperatorOverlay>;
  className?: string;
}) {
  const spec = useStore(store, s => s.spec);
  const positions = useStore(store, s => s.positions);
  const selected = useStore(store, s => s.selected);
  const readonly = useStore(store, s => s.readonly);
  const [fitOnOpen] = useState(() => store.getState().spec.operators.length <= FIT_UP_TO);
  const wrapper = useRef<HTMLDivElement>(null);
  const userMoved = useRef(false);
  const [compact, setCompact] = useState(false);
  const { fitView, screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 };
      setCompact(width < 640 || height < 420);
      if (fitOnOpen && !userMoved.current && Math.abs(height - lastHeight) > 1) void fitView(EDITOR_FIT);
      lastHeight = height;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitOnOpen, fitView]);
  const flow = useMemo(() => toFlow(spec, positions, overlay), [spec, positions, overlay]);
  const [nodes, setNodes, onNodesChange] = useNodesState<OperatorNode>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow.edges);
  const { data: schemas } = useQuery(operatorSchemasQuery());

  // The store is the truth; React Flow keeps what it measured and what is being dragged.
  useEffect(() => {
    setNodes(previous => {
      const before = new Map(previous.map(n => [n.id, n]));
      return flow.nodes.map(n => {
        const p = before.get(n.id);
        const chosen = n.id === selected;
        return p
          ? { ...p, data: n.data, position: p.dragging ? p.position : n.position, selected: chosen }
          : { ...n, selected: chosen };
      });
    });
    setEdges(previous => {
      const picked = new Set(previous.filter(e => e.selected).map(e => e.id));
      return flow.edges.map(e => ({ ...e, selected: picked.has(e.id) }));
    });
  }, [flow, selected, setNodes, setEdges]);

  const edit = store.getState().edit;

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle) return;
      edit(cur =>
        addLink(cur, { operatorID: c.source, portID: c.sourceHandle ?? "" }, { operatorID: c.target, portID: c.targetHandle ?? "" })
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

  const onDrop = useCallback(
    (e: DragEvent) => {
      const schema = schemas?.get(e.dataTransfer.getData(OPERATOR_DRAG_TYPE));
      if (!schema || readonly) return;
      e.preventDefault();
      const op = newOperator(schema);
      const at = screenToFlowPosition({ x: e.clientX - 28, y: e.clientY - 28 });
      store.getState().move({ [op.operatorID]: at });
      edit(cur => addOperator(cur, op));
      store.getState().select(op.operatorID);
    },
    [schemas, readonly, edit, screenToFlowPosition, store]
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(OPERATOR_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: chosen }: OnSelectionChangeParams) => {
      const id = chosen.length === 1 ? (chosen[0]?.id ?? null) : null;
      if (id !== store.getState().selected) store.getState().select(id);
    },
    [store]
  );

  return (
    <div ref={wrapper} className={className} data-workflow-canvas data-editable={!readonly}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={readonly ? undefined : onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStop={(_, __, dragged) =>
          store.getState().move(Object.fromEntries(dragged.map(n => [n.id, { x: n.position.x, y: n.position.y }])))
        }
        onNodesDelete={deleted => edit(cur => deleteOperators(cur, deleted.map(n => n.id)))}
        onEdgesDelete={deleted => edit(cur => deleteLinks(cur, deleted.map(e => e.id)))}
        onSelectionChange={onSelectionChange}
        onMoveStart={event => {
          if (event) userMoved.current = true;
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
        fitView={fitOnOpen}
        fitViewOptions={EDITOR_FIT}
        defaultViewport={EDITOR_VIEWPORT}
        minZoom={0.1}
        colorMode="system">
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        {!compact && <MiniMap pannable zoomable className="!rounded-lg !border" />}
        <Controls showInteractive={false} className="!rounded-lg !border !shadow-none" />
      </ReactFlow>
    </div>
  );
}
