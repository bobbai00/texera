// Beside a chat that has started work: the resource graph, or the same things as a list.

import type { ConversationGraph } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import { List, Network } from "lucide-react";
import { useState } from "react";
import { FromThisChat } from "../shell/FromThisChat";
import { ResourceGraph } from "./ResourceGraph";

export function ResourcePanel({ rid, graph, className }: { rid: string; graph: ConversationGraph; className?: string }) {
  const [view, setView] = useState<"graph" | "list">("graph");
  return (
    <section aria-label="What this chat read, made and ran" className={cn("flex min-h-0 flex-col", className)} data-resource-panel>
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5" role="tablist">
        {(
          [
            ["graph", "Graph", Network],
            ["list", "List", List],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              view === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            data-resource-view={id}>
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>
      {view === "graph" ? <ResourceGraph rid={rid} graph={graph} className="flex-1" /> : <FromThisChat rid={rid} className="flex-1 overflow-y-auto p-3" />}
    </section>
  );
}
