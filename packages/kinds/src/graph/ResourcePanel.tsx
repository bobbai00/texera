// Beside a chat that has started work: the resource graph, or the same things as a list. A click
// on a thing goes into it: its view stands over the graph, with the trail back. What that view
// links to opens there too, after it on the trail, so the chat beside it stays as it is.

import type { ConversationGraph } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import { List, Network } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { FromThisChat } from "../shell/FromThisChat";
import { type ViewHost, ViewHostContext } from "../shell/host";
import { FocusLayer, type Rect, rectWithin } from "./Focus";
import { entryFor, entryForRef, type FocusEntry, pushed } from "./focus";
import { viewOf } from "./model";
import { ResourceGraph } from "./ResourceGraph";

export function ResourcePanel({
  rid,
  graph,
  className,
}: {
  rid: string;
  graph: ConversationGraph;
  className?: string;
}) {
  const [tab, setTab] = useState<"graph" | "list">("graph");
  const [trail, setTrail] = useState<FocusEntry[]>([]);
  const [from, setFrom] = useState<Rect>();
  const section = useRef<HTMLElement>(null);
  const view = useMemo(() => viewOf(graph), [graph]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const host = useMemo<ViewHost>(
    () => ({
      // This chat stands beside the graph already: going to it is going back to the graph.
      open: ref =>
        ref.kind === "conversation" && ref.rid === rid
          ? setTrail([])
          : setTrail(t => pushed(t, entryForRef(viewRef.current, ref))),
      back: () => setTrail(t => t.slice(0, -1)),
      close: () => setTrail([]),
    }),
    [rid]
  );
  const enter = (id: string, el: HTMLElement) => {
    const entry = entryFor(view, id);
    if (!entry) return;
    if (!trail.length) setFrom(section.current ? rectWithin(el, section.current) : undefined);
    setTrail(t => pushed(t, entry));
  };
  const focused = trail.length > 0;
  const tabs = (
    <div className="flex items-center gap-1" role="tablist">
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
          aria-selected={tab === id}
          onClick={() => setTab(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
            tab === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
          data-resource-view={id}>
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
  return (
    <ViewHostContext.Provider value={host}>
      <section
        ref={section}
        aria-label="What this chat read, made and ran"
        className={cn("relative flex min-h-0 flex-col", className)}
        data-resource-panel>
        {tab === "graph" ? (
          <ResourceGraph
            rid={rid}
            graph={graph}
            className="min-h-0 flex-1"
            bar={tabs}
            onOpen={(id, el) => enter(id, el)}
            inert={focused}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col" inert={focused}>
            <div className="flex shrink-0 items-center border-b px-3 py-1.5">{tabs}</div>
            <FromThisChat rid={rid} className="flex-1 overflow-y-auto p-3" />
          </div>
        )}
        {focused && (
          <FocusLayer
            trail={trail}
            view={view}
            root={tab === "graph" ? "Graph" : "List"}
            from={from}
            onTo={i => setTrail(t => t.slice(0, i + 1))}
            onGo={entry => setTrail(t => pushed(t, entry))}
            onClose={() => setTrail([])}
          />
        )}
      </section>
    </ViewHostContext.Provider>
  );
}
