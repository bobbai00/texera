import { Background, BackgroundVariant, type Edge, MarkerType, ReactFlow, ReactFlowProvider, useEdgesState, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutPositions, type OperatorNode, type OperatorOverlay, toFlow, type WorkflowSpec } from "@texera/workflow-model";
import { useEffect, useMemo } from "react";
import { nodeTypes } from "./OperatorNode";

const PREVIEW_FIT = { padding: 0.15, maxZoom: 1 };

export const defaultEdgeOptions = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  style: { strokeWidth: 1.5 },
};

interface Props {
  spec: WorkflowSpec;
  overlay?: Record<string, OperatorOverlay>;
  className?: string;
}

/** A read-only picture of a workflow, as cards show it, laid out from the graph. It follows `spec` as it changes. */
export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Preview {...props} />
    </ReactFlowProvider>
  );
}

function Preview({ spec, overlay, className }: Props) {
  const flow = useMemo(() => toFlow(spec, layoutPositions(spec), overlay), [spec, overlay]);
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
