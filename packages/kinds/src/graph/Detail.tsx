// What a thing on the graph is, in a panel at the graph's side: its kind and version, whether
// this chat made it, what it says it is, how it connects, a workflow's runs and steps, and Open.
// The panel sits beside the graph rather than over it, so it never hides what it describes.

import type { ConversationGraph, GraphNode, GraphRun } from "@texera/catalog-client/types";
import { Button, cn, formatDuration, timeAgo } from "@texera/ui";
import { ArrowUpRight, Blocks, Box, Cpu, Database, Table2, Workflow, X } from "lucide-react";
import type { ReactNode } from "react";
import { PhaseIcon } from "../execution/PhaseIcon";
import { useOpenResource } from "../shell/navigation";
import { refOf } from "../uri";
import type { GraphView } from "./model";
import { lineOf } from "./steps";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Look {
  icon: typeof Database;
  tone: string;
  text: string;
  word: string;
}
const LOOK = {
  data: { icon: Database, tone: "bg-kind-dataset/15 text-kind-dataset", text: "text-kind-dataset", word: "Dataset" },
  table: { icon: Table2, tone: "bg-kind-dataset/10 text-kind-dataset", text: "text-kind-dataset", word: "Table" },
  workflow: {
    icon: Workflow,
    tone: "bg-kind-workflow/15 text-kind-workflow",
    text: "text-kind-workflow",
    word: "Workflow",
  },
  model: { icon: Box, tone: "bg-kind-model/15 text-kind-model", text: "text-kind-model", word: "Model" },
  function: {
    icon: Blocks,
    tone: "bg-kind-operator/15 text-kind-operator",
    text: "text-kind-operator",
    word: "Function",
  },
  unit: {
    icon: Cpu,
    tone: "bg-kind-computing-unit/15 text-kind-computing-unit",
    text: "text-kind-computing-unit",
    word: "Computing unit",
  },
} satisfies Record<string, Look>;
const lookOf = (n: GraphNode): Look =>
  n.kind === "execution"
    ? LOOK.table
    : n.role === "workflow"
      ? LOOK.workflow
      : n.role === "model"
        ? LOOK.model
        : n.role === "function"
          ? LOOK.function
          : n.role === "unit"
            ? LOOK.unit
            : LOOK.data;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h4 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}

/** A list of things on the graph; a click picks one. */
function Things({ nodes, onChoose }: { nodes: GraphNode[]; onChoose: (id: string) => void }) {
  return (
    <ul className="grid gap-0.5">
      {nodes.map(n => {
        const look = lookOf(n);
        return (
          <li key={n.uri}>
            <button
              type="button"
              className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted"
              onClick={() => onChoose(n.uri)}>
              <look.icon className={cn("size-3.5 shrink-0", look.text)} />
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {n.kind === "execution"
                  ? n.rows !== undefined
                    ? plural(n.rows, "row")
                    : ""
                  : n.version !== undefined
                    ? `v${n.version}`
                    : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Run({ run }: { run: GraphRun }) {
  const { beside } = useOpenResource();
  const ref = refOf(run.uri);
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-xs hover:underline"
        onClick={() => ref && beside(ref)}>
        <PhaseIcon phase={run.phase as never} className="size-3.5" />
        <span className="flex-1">{run.startedAt ? timeAgo(run.startedAt) : run.phase}</span>
        <span className="text-muted-foreground tabular-nums">
          {run.reused > 0 ? `${run.reused}/${run.steps} reused · ` : `${plural(run.steps, "step")} · `}
          {formatDuration(run.startedAt, run.finishedAt)}
        </span>
      </button>
    </li>
  );
}

export function GraphDetail({
  id,
  view,
  graph,
  onChoose,
  onClose,
}: {
  id: string;
  view: GraphView;
  graph: ConversationGraph;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const { beside } = useOpenResource();
  const node = view.nodes.get(id);
  const work = view.works.find(w => w.id === id);
  const planned = work?.planned ?? view.data.get(id)?.planned ?? view.units.get(id)?.planned;
  const name = node?.name ?? planned?.name ?? "";
  const look = node
    ? lookOf(node)
    : planned?.kind === "computing-unit"
      ? LOOK.unit
      : planned?.kind === "dataset"
        ? LOOK.data
        : LOOK.workflow;
  const sub = node
    ? `${look.word}${node.version !== undefined ? ` · v${node.version}` : ""} · ${node.made ? "made in this chat" : "worked from"}`
    : `${look.word} · planned`;
  const of = (ids: string[]) => ids.map(i => view.nodes.get(i)).filter((n): n is GraphNode => !!n);
  const worksUsing = (uri: string) =>
    of(
      view.works
        .filter(w => w.uses.some(u => u.uri === uri) || w.reads.some(r => r.data === uri) || w.unit === uri)
        .map(w => w.id)
    );
  const ref = node ? refOf(node.uri) : undefined;
  return (
    <aside
      className={cn(
        "grid w-72 shrink-0 content-start gap-3 overflow-y-auto border-l bg-card p-3.5 text-sm",
        // In a narrow panel the details are a sheet along the bottom, and the graph keeps its width.
        "@max-[46rem]:absolute @max-[46rem]:inset-x-0 @max-[46rem]:bottom-0 @max-[46rem]:z-10 @max-[46rem]:max-h-[46%] @max-[46rem]:w-auto @max-[46rem]:border-t @max-[46rem]:border-l-0 @max-[46rem]:shadow-[0_-10px_28px_-14px_rgb(0_0_0/0.3)]"
      )}
      data-graph-detail={id}
      aria-label={`About ${name}`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5">
        <span className={cn("grid size-8 place-items-center rounded-lg", look.tone)}>
          <look.icon className="size-4" />
        </span>
        <div>
          <p className="leading-snug font-semibold [overflow-wrap:anywhere]">{name}</p>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {(node?.description || planned?.detail) && (
        <p className="text-sm leading-relaxed text-muted-foreground">{node?.description ?? planned?.detail}</p>
      )}

      {work && (
        <>
          {node?.runs && node.runs.length > 0 ? (
            <Section title="Runs">
              <ul className="grid gap-1" data-graph-runs>
                {node.runs.map(run => (
                  <Run key={run.uri} run={run} />
                ))}
              </ul>
            </Section>
          ) : (
            !planned && <p className="text-xs text-muted-foreground">Not run yet.</p>
          )}
          {work.unit && view.nodes.get(work.unit) && (
            <Section title={node?.runs ? "Runs on" : "Will run on"}>
              <Things nodes={of([work.unit])} onChoose={onChoose} />
            </Section>
          )}
          {work.reads.length > 0 && (
            <Section title="Reads">
              <Things nodes={of(work.reads.map(r => r.data))} onChoose={onChoose} />
            </Section>
          )}
          {work.uses.length > 0 && (
            <Section title="Uses">
              <Things nodes={work.uses} onChoose={onChoose} />
            </Section>
          )}
          {work.results.some(r => view.nodes.has(r)) && (
            <Section title="Makes">
              <Things nodes={of(work.results)} onChoose={onChoose} />
            </Section>
          )}
          {work.steps.length > 0 && (
            <Section title={plural(work.steps.length, "step")}>
              <ol className="grid gap-0.5 font-mono text-xs">
                {work.steps.map(step => {
                  const line = lineOf(step, view.nodes);
                  return (
                    <li key={step.id} className="flex min-w-0 gap-2">
                      <span className="shrink-0">{step.id}</span>
                      <span className="truncate text-muted-foreground" title={`${line.op} ${line.text}`}>
                        {line.uses ? line.uses.name : line.op} {line.text}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Section>
          )}
          {work.plannedRun && (
            <Section title="Planned">
              <p className="text-xs">{work.plannedRun.name}</p>
            </Section>
          )}
        </>
      )}

      {node?.kind === "execution" && (
        <Section title="Made by">
          <p className="text-xs">
            Step <span className="font-mono">{node.step}</span> of the newest run
            {node.rows !== undefined ? `, ${plural(node.rows, "row")}` : ""}.
          </p>
          <Things nodes={of(view.works.filter(w => w.results.includes(id)).map(w => w.id))} onChoose={onChoose} />
        </Section>
      )}
      {node &&
        node.kind !== "execution" &&
        (node.role === "data" || node.role === "model" || node.role === "function") &&
        worksUsing(node.uri).length > 0 && (
          <Section title={node.role === "data" ? "Read by" : "Used by"}>
            <Things nodes={worksUsing(node.uri)} onChoose={onChoose} />
          </Section>
        )}
      {node?.role === "data" && node.kind !== "execution" && (view.data.get(id)?.files.length ?? 0) > 0 && (
        <Section title="Files read">
          <ul className="grid gap-0.5 font-mono text-xs">
            {view.data.get(id)?.files.map(f => (
              <li key={f} className="truncate">
                {f}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {node?.role === "unit" && (
        <>
          <p className="text-xs">
            {node.state ? `It is ${node.state}.` : ""}{" "}
            {graph.edges.some(e => e.relation === "runsOn" && e.to === id) ? "" : "Nothing has run on it yet."}
          </p>
          {worksUsing(id).length > 0 && (
            <Section title="Runs here">
              <Things nodes={worksUsing(id)} onChoose={onChoose} />
            </Section>
          )}
        </>
      )}

      {ref && (
        <Button size="sm" variant="outline" className="justify-self-start" onClick={() => beside(ref)} data-graph-open>
          <ArrowUpRight /> Open
        </Button>
      )}
    </aside>
  );
}
