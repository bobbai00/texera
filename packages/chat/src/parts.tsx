// Message parts. A tool result that names a resource renders that resource's card; the
// tool itself is a one-line step. Everything comes from the kinds registry, never from
// a tool name. A handoff is a divider between the agents of a conversation.

import { isKindId, KindIcon, PrincipalName, ResourceCard, refOf, UriChip } from "@texera/kinds";
import { Button, cn } from "@texera/ui";
import { AlertTriangle, ArrowRightLeft, Brain, Check, ChevronDown, CircleHelp, ListChecks, Loader2, Network, ShieldCheck, Wrench, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import type { Part } from "./model";
import { blocksOf, isResourceUri } from "./resource-lines";

const Markdown = lazy(() => import("@texera/ui/markdown"));

/** A URI in backticks reads as the resource's name. */
const chipOf = (code: string): ReactNode | undefined => (isResourceUri(code) ? <UriChip uri={code} emphasis /> : undefined);

/** What the agent wrote: words, and cards for the resources it put on lines of their own. */
export function TextPart({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === "words" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and only grow at the end
          <Suspense key={i} fallback={<p className="whitespace-pre-wrap">{block.text}</p>}>
            <Markdown text={block.text} animating={streaming && i === blocks.length - 1} inline={chipOf} />
          </Suspense>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and only grow at the end
          <div key={i} className="grid grid-cols-[repeat(auto-fill,minmax(min(17rem,100%),1fr))] gap-2" data-part="resources">
            {block.uris.map(uri => {
              const ref = refOf(uri);
              return ref ? <ResourceCard key={uri} ref={ref} /> : <UriChip key={uri} uri={uri} />;
            })}
          </div>
        )
      )}
    </>
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
      <button type="button" onClick={() => setOpen(o => !o)} className={cn("flex w-full items-center gap-2 py-0.5 text-left text-sm", part.status === "error" ? "text-destructive" : "text-muted-foreground")}>
        {part.status === "running" ? <Loader2 className="size-4 shrink-0 animate-spin" /> : part.status === "error" ? <AlertTriangle className="size-4 shrink-0" /> : <Check className="size-4 shrink-0 text-success" />}
        <Wrench className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate">
          {label}
          {part.status === "running" ? "…" : ""}
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-2 text-2xs">
          {part.args && <pre className="scrollbar-thin max-h-40 overflow-auto font-mono whitespace-pre-wrap">{part.input !== undefined ? JSON.stringify(part.input, null, 2) : part.args}</pre>}
          {part.result !== undefined && (
            <pre className="scrollbar-thin max-h-60 overflow-auto border-t pt-2 font-mono whitespace-pre-wrap">{typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 2)}</pre>
          )}
        </div>
      )}
      {part.error && <p className="text-xs whitespace-pre-wrap text-destructive">{part.error}</p>}
    </div>
  );
}

/** The conversation changed hands: by the agent (a handoff) or by the person (the switcher or /mode). */
export function HandoffPart({ part, toName, fromName }: { part: Extract<Part, { type: "handoff" }>; toName: string; fromName?: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground" data-part="handoff" data-handoff-by={part.by} data-handoff-to={toName}>
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
        <ArrowRightLeft className="size-3.5" />
        {part.by === "agent" ? `${fromName ?? part.name} handed the chat to ${toName}` : `Switched to ${toName}`}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The agent's shared state, when it exposes one. */
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

type ToolPart = Extract<Part, { type: "tool" }>;

interface Plan {
  goal?: string;
  reads?: string[];
  makes?: { kind?: string; name?: string; detail?: string }[];
}

/** What the agent said it will do before its first change: the goal, what it reads, what it makes. */
export function PlanPart({ part, onOpenGraph }: { part: ToolPart; onOpenGraph?: () => void }) {
  const plan = (part.input ?? {}) as Plan;
  const reads = (plan.reads ?? []).filter(uri => typeof uri === "string");
  const makes = (plan.makes ?? []).filter(m => m && typeof m.name === "string");
  return (
    <div className="space-y-2 rounded-xl border bg-muted/20 p-3" data-part="plan">
      <div className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <ListChecks className="size-3.5" /> Plan
        {onOpenGraph && (
          // The graph is never drawn over a canvas: it is on the chat's own page.
          <button type="button" onClick={onOpenGraph} className="ml-auto flex items-center gap-1 normal-case tracking-normal text-primary hover:underline" data-open-graph>
            <Network className="size-3.5" /> Open graph
          </button>
        )}
      </div>
      {plan.goal && <p className="font-medium">{plan.goal}</p>}
      {reads.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-plan-reads={reads.length}>
          <span className="text-xs text-muted-foreground">Reads</span>
          {reads.map(uri => (
            <UriChip key={uri} uri={uri} />
          ))}
        </div>
      )}
      {makes.length > 0 && (
        <ul className="space-y-1" data-plan-makes={makes.length}>
          {makes.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the plan's items are positional
            <li key={i} className="flex items-start gap-1.5 text-xs" data-plan-make={m.kind}>
              <span className="shrink-0 text-muted-foreground">Makes</span>
              {m.kind && isKindId(m.kind) && <KindIcon kind={m.kind} className="size-4 shrink-0 rounded [&_svg]:size-2.5" />}
              <span className="min-w-0">
                <span className="font-medium">{m.name}</span>
                {m.detail && <span className="text-muted-foreground"> · {m.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Question {
  question?: string;
  options?: { label?: string; detail?: string }[];
}

/** A question with choices; the person's pick is their next message. */
export function AskPart({ part, onPick }: { part: ToolPart; onPick?: (label: string) => void }) {
  const q = (part.input ?? {}) as Question;
  const options = (q.options ?? []).filter((o): o is { label: string; detail?: string } => typeof o?.label === "string");
  return (
    <div className="space-y-2 rounded-xl border p-3" data-part="ask">
      <p className="flex items-start gap-2 font-medium">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        {q.question}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map(o => (
          // A choice says what it costs in a line of its own, which wraps within the card.
          <Button key={o.label} variant="outline" size="sm" className="h-auto max-w-full flex-col items-start gap-0 whitespace-normal py-1.5 text-left" disabled={!onPick} onClick={() => onPick?.(o.label)} data-ask-option={o.label}>
            <span>{o.label}</span>
            {o.detail && <span className="text-2xs font-normal text-muted-foreground">{o.detail}</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * A change the agent asked to make, in manual work mode: what it is, and Approve or Decline
 * while it waits; then who decided what.
 */
export function ApprovalPart({
  part,
  call,
  onDecide,
}: {
  part: Extract<Part, { type: "approval" }>;
  /** The call the change is, once it has run: its result or its error. */
  call?: ToolPart;
  onDecide?: (approved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = part.reason ?? humanize(part.toolName);
  return (
    <div
      className={cn("space-y-2 rounded-xl border p-3", part.state === "pending" ? "border-primary/40 bg-primary/5" : "bg-muted/20")}
      data-part="approval"
      data-approval-state={part.state}
      data-approval-tool={part.toolName}>
      <div className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <ShieldCheck className="size-3.5" /> {part.state === "pending" ? "Waiting for your approval" : "Change"}
      </div>
      <button type="button" className="flex w-full items-center gap-2 text-left font-medium" onClick={() => setOpen(o => !o)}>
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && part.input !== undefined && (
        <pre className="scrollbar-thin max-h-40 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(part.input, null, 2)}</pre>
      )}
      {part.state === "pending" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={!onDecide} onClick={() => onDecide?.(true)} data-approve>
            <Check className="size-3.5" /> Approve
          </Button>
          <Button size="sm" variant="outline" disabled={!onDecide} onClick={() => onDecide?.(false)} data-decline>
            <X className="size-3.5" /> Decline
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-approval-decided={part.state}>
          {part.state === "approved" ? <Check className="size-3.5 text-success" /> : <X className="size-3.5" />}
          {part.state === "approved" ? "Approved" : "Declined"}
          {part.decidedBy && (
            <>
              {" by "}
              <PrincipalName pid={part.decidedBy} />
            </>
          )}
        </p>
      )}
      {part.state === "approved" && call?.status === "error" && call.error && <p className="text-xs whitespace-pre-wrap text-destructive">{call.error}</p>}
    </div>
  );
}
