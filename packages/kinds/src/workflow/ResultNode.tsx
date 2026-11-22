// A result an execution kept, as a small cylinder under the card it came out of, joined to its
// port by a dashed line: the table the execution wrote. A click opens it in the results window;
// a result of an earlier version whose operator changed since is drawn faint and says so.

import { cn, formatNumber } from "@texera/ui";
import { RESULT_CHIP, RESULT_HANDLE, type ResultNode as ResultNodeType } from "@texera/workflow-model";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Cylinder } from "lucide-react";
import { memo } from "react";
import { useStore } from "zustand";
import { portKey, useCanvas } from "./canvas-view";

export const ResultChip = memo(function ResultChip({ data }: NodeProps<ResultNodeType>) {
  const { view } = useCanvas();
  const key = portKey(data.operatorID, data.port);
  const open = useStore(view, s => s.result === key);
  const rows = data.rows === undefined ? "result" : `${formatNumber(data.rows)} row${data.rows === 1 ? "" : "s"}`;
  const said = data.label ? `${data.label}: ${rows}` : rows;
  return (
    <button
      type="button"
      onClick={() => view.getState().show(open ? null : key)}
      title={
        data.stale !== undefined
          ? `${said}, from version ${data.stale}: the operator, or one it reads from, changed since`
          : `${said}: open the table`
      }
      style={{ width: RESULT_CHIP.width, height: RESULT_CHIP.height }}
      className={cn(
        "nodrag nopan flex items-center gap-1.5 rounded-full border bg-card px-2.5 text-left text-xs shadow-xs hover:bg-accent",
        open ? "border-primary ring-2 ring-primary/40" : "border-primary/50",
        data.stale !== undefined && "border-dashed opacity-55"
      )}
      data-result-chip={key}
      data-result-open={open ? "true" : undefined}
      data-result-stale={data.stale}>
      <Handle
        id={RESULT_HANDLE}
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
      <Cylinder className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate tabular-nums">{said}</span>
    </button>
  );
});
