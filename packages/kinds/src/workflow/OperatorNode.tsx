import { Handle, type NodeProps, Position } from "@xyflow/react";
import { cn } from "@texera/ui";
import { type OperatorNode as OperatorNodeType, operatorImage } from "@texera/workflow-model";
import { memo } from "react";

const portTop = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;

/** One operator: icon tile, display name, and a handle per port. Memoized so dragging one node does not re-render the rest. */
export const OperatorNode = memo(function OperatorNode({ data, selected }: NodeProps<OperatorNodeType>) {
  return (
    <div className="group relative flex w-14 flex-col items-center" data-operator-type={data.operatorType}>
      <div
        className={cn(
          // Operator icons are dark glyphs drawn for a white ground, so the tile stays white in dark mode too.
          "relative size-14 rounded-xl border bg-white p-2.5 shadow-sm transition-[box-shadow,border-color] dark:border-white/15",
          selected ? "border-primary ring-4 ring-primary/15" : "group-hover:border-foreground/25",
          data.disabled && "opacity-50",
          data.status === "running" && "border-warning",
          data.status === "completed" && "border-success",
          (data.status === "failed" || data.error) && "border-destructive"
        )}>
        <img src={operatorImage(data.operatorType)} alt="" className="size-full object-contain" draggable={false} loading="lazy" />
        {data.inputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="target"
            position={Position.Left}
            style={{ top: portTop(i, data.inputs.length) }}
            className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
            title={p.label}
          />
        ))}
        {data.outputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="source"
            position={Position.Right}
            style={{ top: portTop(i, data.outputs.length) }}
            className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
            title={p.label}
          />
        ))}
      </div>
      {data.rows !== undefined && !data.error && (
        <span className="absolute -top-2 -right-2 rounded-full border bg-background px-1.5 text-2xs font-medium tabular-nums text-muted-foreground shadow-xs">
          {data.rows.toLocaleString("en")}
        </span>
      )}
      {data.error && (
        <span
          className="absolute -top-2 -right-2 flex size-4 items-center justify-center rounded-full bg-destructive text-2xs font-bold text-white"
          title={data.error}>
          !
        </span>
      )}
      <div className="pointer-events-none absolute top-full mt-1.5 w-36 text-center text-xs leading-tight font-medium text-foreground">
        {data.label}
      </div>
    </div>
  );
});

export const nodeTypes = { operator: OperatorNode };
