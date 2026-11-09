// A dataset or model an operator's settings name, as a chip above its card. It says what it is and
// opens it; it is read off the settings, so it cannot be moved, picked or wired.

import { cn } from "@texera/ui";
import { RESOURCE_CHIP, type ResourceNode as ResourceNodeType } from "@texera/workflow-model";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Box, Database } from "lucide-react";
import { memo } from "react";
import { useOpenResource } from "../shell/navigation";
import { useNamed } from "../shell/RanOn";
import { refOf } from "../uri";

export const ResourceChip = memo(function ResourceChip({ data }: NodeProps<ResourceNodeType>) {
  const name = useNamed(data.uri);
  const { beside } = useOpenResource();
  const ref = refOf(data.uri);
  const model = data.kind === "model";
  const Icon = model ? Box : Database;
  return (
    <button
      type="button"
      onClick={() => ref && beside(ref)}
      title={data.file ? `${name}: ${data.file}` : name}
      style={{ width: RESOURCE_CHIP.width, height: RESOURCE_CHIP.height }}
      className={cn(
        "nodrag nopan flex items-center gap-1.5 rounded-lg border border-dashed bg-card px-2 text-left text-xs hover:bg-accent",
        model ? "border-kind-model/60" : "border-kind-dataset/60"
      )}
      data-canvas-resource={data.kind}>
      <Icon className={cn("size-3.5 shrink-0", model ? "text-kind-model" : "text-kind-dataset")} aria-hidden />
      <span className="min-w-0 truncate font-medium">{name}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
    </button>
  );
});
