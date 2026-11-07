import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { cn } from "./utils";

export interface Column {
  name: string;
  type?: string;
}

const ROW_HEIGHT = 32;
const NUMERIC = new Set(["integer", "long", "double"]);

/**
 * A cell as text. A double says its value without the noise of binary fractions (5.552, not
 * 5.551999999999999); the exact value is the cell's title.
 */
export const cell = (v: unknown, type?: string) =>
  v === null || v === undefined
    ? ""
    : type === "double" && typeof v === "number" && Number.isFinite(v)
      ? String(Number(v.toPrecision(12)))
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

/**
 * A table for results and dataset previews. Only the rows in view are in the DOM, so a
 * 100k-row result scrolls as smoothly as a 10-row one.
 */
export function DataTable({ columns, rows, className }: { columns: Column[]; rows: unknown[][]; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const template = `3rem repeat(${columns.length}, minmax(8rem, 1fr))`;

  return (
    <div ref={scrollRef} className={cn("scrollbar-thin overflow-auto text-sm", className)} data-table>
      <div className="min-w-max" role="table" aria-rowcount={rows.length + 1}>
        <div
          role="row"
          className="sticky top-0 z-10 grid items-center border-b bg-muted/80 text-xs font-medium text-muted-foreground backdrop-blur"
          style={{ gridTemplateColumns: template }}>
          <div role="columnheader" className="px-2 py-2 text-right">
            #
          </div>
          {columns.map(c => (
            <div key={c.name} role="columnheader" className="truncate px-3 py-2">
              {c.name}
              {c.type && <span className="ml-1.5 font-normal opacity-60">{c.type}</span>}
            </div>
          ))}
        </div>
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(v => {
            const row = rows[v.index] ?? [];
            return (
              <div
                key={v.key}
                role="row"
                aria-rowindex={v.index + 2}
                className="absolute inset-x-0 grid items-center border-b border-border/60 hover:bg-accent/50"
                style={{ gridTemplateColumns: template, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}>
                <div role="cell" className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                  {v.index + 1}
                </div>
                {columns.map((c, i) => (
                  <div
                    key={c.name}
                    role="cell"
                    className={cn("truncate px-3 py-1.5", NUMERIC.has(c.type ?? "") && "text-right font-mono tabular-nums")}
                    title={c.type === "double" && typeof row[i] === "number" ? String(row[i]) : undefined}>
                    {cell(row[i], c.type)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
