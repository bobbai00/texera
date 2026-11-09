import { useQuery } from "@tanstack/react-query";
import { cn, useDark } from "@texera/ui";
import {
  type CanvasNode,
  canvasFlow,
  type OperatorOverlay,
  pictureOf,
  placeMissing,
  resourceRoom,
  type WorkflowSpec,
} from "@texera/workflow-model";
import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { operatorSchemasQuery } from "../queries";
import { useScope } from "../scope";
import { edgeOptions } from "../shell/canvas";
import { CanvasContext, type CanvasView, createCanvasView, portKey } from "./canvas-view";
import { CanvasControls } from "./controls";
import { DensityToggle, ResourcesToggle, spread, useRowSpread } from "./density";
import { useFollow, useFrame, useReframe } from "./framing";
import { nodeTypes } from "./OperatorNode";

/** A picture shows the whole workflow, however small. */
const PICTURE_FIT = { padding: 0.15, maxZoom: 1 };

interface Props {
  spec: WorkflowSpec;
  overlay?: Record<string, OperatorOverlay>;
  /**
   * How this canvas is looked at, when what is around it shares that (the results under it
   * follow the result its cards point at). With it the canvas has its controls: how much the
   * cards say, and the zoom. Without, it is a picture.
   */
  view?: CanvasView;
  className?: string;
  /** What floats over the canvas, within it: the results of the execution. */
  children?: ReactNode;
}

/**
 * A workflow to look at, laid out from its graph: the picture a card shows, or with a `view`
 * the canvas of an execution. It follows `spec` as it changes. Give it a ReactFlowProvider
 * above when something beside it reads the canvas; it makes its own otherwise.
 */
export function WorkflowCanvas({ provided = false, ...props }: Props & { provided?: boolean }) {
  if (provided) return <Shown {...props} />;
  return (
    <ReactFlowProvider>
      <Shown {...props} />
    </ReactFlowProvider>
  );
}

function Shown({ spec, overlay, view: shared, className, children }: Props) {
  const view = useMemo(() => shared ?? createCanvasView(), [shared]);
  const density = useStore(view, s => s.density);
  // A small picture has no room for what its operators use; a canvas with controls says it when asked.
  const showResources = useStore(view, s => s.resources) && shared !== undefined;
  const k = useRowSpread(null, showResources ? resourceRoom(spec) : 0);
  // Without a view to share it is a picture: operators are icons, closer together. Either way the
  // operators sit where the version placed them.
  const picture = shared === undefined;
  const flow = useMemo(() => {
    const placed = picture ? pictureOf(spec) : spread(placeMissing(spec, spec.layout ?? {}), k);
    return canvasFlow(spec, placed, overlay, showResources);
  }, [spec, picture, k, overlay, showResources]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(flow.nodes);
  const [edges, setEdges] = useEdgesState<Edge>(flow.edges);
  const { fitView } = useReactFlow();
  const frame = useFrame(view);
  const measured = useNodesInitialized();
  const dark = useDark();
  const { data: schemas } = useQuery(operatorSchemasQuery(useScope()));
  const canvas = useMemo(() => ({ view, schemas, picture }), [view, schemas, picture]);

  // The spec says what the cards are and where; React Flow keeps what it measured of each.
  // A card given anew without its size would wait to be measured again, which never comes
  // for one whose size did not change.
  useEffect(() => {
    setNodes(previous => {
      const before = new Map(previous.map(n => [n.id, n]));
      return flow.nodes.map(n => {
        const p = before.get(n.id);
        return (p ? { ...p, data: n.data, position: n.position } : n) as CanvasNode;
      });
    });
    setEdges(flow.edges);
  }, [flow, setNodes, setEdges]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: brought back into view when the cards change size
  useEffect(() => {
    if (!measured) return;
    if (shared) void frame();
    else void fitView(PICTURE_FIT);
  }, [measured, density, k]);
  useFollow(view);
  // A canvas with controls is framed again when its room changes, until the person moves it.
  const wrapper = useRef<HTMLDivElement>(null);
  const userMoved = useRef(false);
  const still = useCallback(() => !picture && !userMoved.current, [picture]);
  useReframe(wrapper, frame, still);
  // The results window opening over the canvas, or put away: framed again around it.
  const covering = useStore(view, s => (s.covered ? "covered" : "clear"));
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the window comes or goes
  useEffect(() => {
    if (shared && measured && still()) void frame();
  }, [covering]);

  return (
    <CanvasContext value={canvas}>
      <div
        ref={wrapper}
        className={cn("relative", className)}
        data-workflow-canvas
        data-editable="false"
        data-density={density}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={edgeOptions}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          // A canvas with controls answers to clicks on its cards; a picture does not.
          elementsSelectable={shared !== undefined}
          zoomOnScroll={shared !== undefined}
          preventScrolling={shared !== undefined}
          panOnDrag
          onMoveStart={event => {
            if (event) userMoved.current = true;
          }}
          // A click on a card shows its result, when the execution kept one.
          onNodeClick={(_, node) => {
            const port = node.type === "operator" ? node.data.results?.[0] : undefined;
            if (shared && port) view.getState().show(portKey(node.id, port));
          }}
          fitView={shared === undefined}
          fitViewOptions={PICTURE_FIT}
          minZoom={0.1}
          colorMode={dark ? "dark" : "light"}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          {shared && (
            <>
              <Panel position="top-left" className="flex items-center gap-2">
                <DensityToggle view={view} />
                <ResourcesToggle view={view} />
              </Panel>
              <CanvasControls view={view} />
            </>
          )}
        </ReactFlow>
        {children}
      </div>
    </CanvasContext>
  );
}
