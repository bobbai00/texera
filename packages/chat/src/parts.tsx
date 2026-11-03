// Message parts. A tool result that names a resource renders that resource's card; the
// tool itself is a one-line step. Everything comes from the kinds registry, never from
// a tool name.

import { ResourceCard } from "@texera/kinds";
import { Badge, Button, cn } from "@texera/ui";
import { AlertTriangle, Bot, Brain, Check, ChevronDown, Loader2, ShieldQuestion, Wrench } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { Part } from "./model";

const Markdown = lazy(() => import("./Markdown"));

export function TextPart({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
      <Markdown text={text} animating={streaming} />
    </Suspense>
  );
}

export function ReasoningPart({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <details className="group text-muted-foreground" data-part="reasoning">
      <summary className="flex cursor-default list-none items-center gap-1.5 text-xs">
        <Brain className="size-3.5" /> Reasoning
      </summary>
      <p className="mt-1 border-l-2 pl-3 text-xs whitespace-pre-wrap">{text}</p>
    </details>
  );
}

const humanize = (name: string) => name.replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());

export function ToolCallPart({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const label = humanize(part.name);
  return (
    <div className="space-y-2" data-part="tool" data-tool={part.name} data-tool-state={part.status}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn("flex w-full items-center gap-2 py-0.5 text-left text-sm", part.status === "error" ? "text-destructive" : "text-muted-foreground")}>
        {part.status === "running" ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : part.status === "error" ? (
          <AlertTriangle className="size-4 shrink-0" />
        ) : (
          <Check className="size-4 shrink-0 text-success" />
        )}
        <Wrench className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate">
          {label}
          {part.status === "running" ? "…" : ""}
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-2 text-2xs">
          {part.args && (
            <pre className="scrollbar-thin max-h-40 overflow-auto font-mono whitespace-pre-wrap">{part.input !== undefined ? JSON.stringify(part.input, null, 2) : part.args}</pre>
          )}
          {part.result !== undefined && (
            <pre className="scrollbar-thin max-h-60 overflow-auto border-t pt-2 font-mono whitespace-pre-wrap">
              {typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 2)}
            </pre>
          )}
        </div>
      )}
      {part.error && <p className="text-xs whitespace-pre-wrap text-destructive">{part.error}</p>}
      {part.resources.map(ref => (
        <ResourceCard key={`${ref.kind}:${ref.rid}`} ref={ref} />
      ))}
    </div>
  );
}

export function SubagentPart({ part }: { part: Extract<Part, { type: "subagent" }> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground" data-part="subagent">
      <Bot className="size-3.5" />
      <span className="font-medium text-foreground">{part.name}</span>
      {part.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : part.status === "error" ? <Badge tone="danger">failed</Badge> : <Badge tone="success">done</Badge>}
      {part.error && <span className="truncate text-destructive">{part.error}</span>}
    </div>
  );
}

/** A run that stopped to ask: the approval surface. Resuming is wired when the runtime supports it. */
export function ApprovalPart({ part, onResume }: { part: Extract<Part, { type: "approval" }>; onResume?: (approve: boolean) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm" data-part="approval">
      <p className="flex items-center gap-2 font-medium">
        <ShieldQuestion className="size-4 text-warning" /> The agent is waiting for your approval
      </p>
      {part.interrupts.map(i => (
        <p key={i.id} className="text-xs text-muted-foreground">
          {i.reason ?? i.id}
        </p>
      ))}
      <div className="flex gap-2">
        <Button size="xs" onClick={() => onResume?.(true)} disabled={!onResume}>
          Approve
        </Button>
        <Button size="xs" variant="outline" onClick={() => onResume?.(false)} disabled={!onResume}>
          Decline
        </Button>
      </div>
    </div>
  );
}

/** The agent's shared state, when it exposes one; the workflow panel shows drafts, this shows the rest. */
export function StatePart({ state }: { state: unknown }) {
  if (state === undefined || state === null) return null;
  return (
    <details className="text-2xs text-muted-foreground" data-part="state">
      <summary className="cursor-default list-none">Agent state</summary>
      <pre className="scrollbar-thin mt-1 max-h-40 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono">{JSON.stringify(state, null, 2)}</pre>
    </details>
  );
}

export function ErrorPart({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive" data-part="error">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> <span className="whitespace-pre-wrap">{message}</span>
    </p>
  );
}
