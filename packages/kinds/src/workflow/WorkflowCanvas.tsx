import {
  Background,
  BackgroundVariant,
  type Edge,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type OperatorNode, type OperatorOverlay, toFlow, type WorkflowContent } from "@texera/workflow-model";
import { useEffect, useMemo } from "react";
import { nodeTypes } from "./OperatorNode";

const PREVIEW_FIT = { padding: 0.15, maxZoom: 1 };

export const defaultEdgeOptions = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  style: { strokeWidth: 1.5 },
};

interface Props {
  content: WorkflowContent;
  overlay?: Record<string, OperatorOverlay>;
  className?: string;
}

/** A read-only picture of a workflow, as cards show it. It follows `content` as it changes. */
export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Preview {...props} />
    </ReactFlowProvider>
  );
}

function Preview({ content, overlay, className }: Props) {
  const flow = useMemo(() => toFlow(content, overlay), [content, overlay]);
  const [nodes, setNodes, onNodesChange] = useNodesState<OperatorNode>(flow.nodes);
  const [edges, setEdges] = useEdgesState<Edge>(flow.edges);
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow, setNodes, setEdges]);
  useEffect(() => {
    if (measured) void fitView(PREVIEW_FIT);
  }, [measured, fitView]);

  return (
    <div className={className} data-workflow-canvas>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={onNodesChange}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        panOnDrag
        fitView
        fitViewOptions={PREVIEW_FIT}
        minZoom={0.1}
        colorMode="system">
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      </ReactFlow>
    </div>
  );
}
