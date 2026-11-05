import { useQuery } from "@tanstack/react-query";
import { Input, Skeleton } from "@texera/ui";
import { type OperatorSchema, operatorImage } from "@texera/workflow-model";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { operatorSchemasQuery } from "../queries";
import { useScope } from "../scope";

export const OPERATOR_DRAG_TYPE = "application/x-texera-operator";

// Not offered for new workflows, as in the classic operator menu.
const HIDDEN = new Set(["PythonUDF", "Dummy", "Sleep"]);

/** Searchable, grouped list of every operator type the caller may use; click one, or drag it onto the canvas, to add it. */
export function OperatorPalette({ onAdd }: { onAdd?: (operatorType: string) => void }) {
  const { data } = useQuery(operatorSchemasQuery(useScope()));
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());

  const groups = useMemo(() => {
    if (!data) return [];
    const byGroup = new Map<string, OperatorSchema[]>();
    const sorted = [...data.values()].sort((a, b) => a.userFriendlyName.localeCompare(b.userFriendlyName));
    for (const op of sorted) {
      if (HIDDEN.has(op.operatorType)) continue;
      if (q && !`${op.userFriendlyName} ${op.operatorType} ${op.operatorGroupName}`.toLowerCase().includes(q)) continue;
      const list = byGroup.get(op.operatorGroupName) ?? [];
      list.push(op);
      byGroup.set(op.operatorGroupName, list);
    }
    // Custom operators first, then the engine's groups alphabetically.
    return [...byGroup.entries()].sort(([a], [b]) => (a === "Custom" ? -1 : b === "Custom" ? 1 : a.localeCompare(b)));
  }, [data, q]);

  return (
    <div className="flex h-full flex-col" data-operator-palette>
      <div className="relative p-2">
        <Search className="absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search operators" className="h-8 pl-7 text-xs" />
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {!data &&
          Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="mb-1.5 h-7" />
          ))}
        {groups.map(([group, ops]) => (
          <section key={group} className="mb-2">
            <h4 className="px-1.5 py-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{group}</h4>
            {ops.map(op => (
              <button
                type="button"
                key={op.operatorType}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(OPERATOR_DRAG_TYPE, op.operatorType);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onAdd?.(op.operatorType)}
                title={op.operatorDescription}
                data-palette-operator={op.operatorType}
                className="flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent active:cursor-grabbing">
                <img src={operatorImage(op.operatorType)} alt="" className="size-5 object-contain" loading="lazy" />
                <span className="truncate">{op.userFriendlyName}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
