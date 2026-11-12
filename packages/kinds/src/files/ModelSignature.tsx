// What a model version reads and what it adds, drawn the way a workflow uses it: the columns it
// takes from each row on one side, the model in the middle, the columns it gives back on the
// other. The About tab shows it whole; a card says it in two lines.

import type { Attribute, ModelContract } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import { ArrowDown, ArrowRight, Binary, Box, Clock, Hash, type LucideIcon, Plus, ToggleLeft, Type } from "lucide-react";

/** A column type's sign: a number, text, yes or no, a moment, bytes. */
const SIGN: Record<string, LucideIcon> = {
  integer: Hash,
  long: Hash,
  double: Hash,
  string: Type,
  boolean: ToggleLeft,
  timestamp: Clock,
  binary: Binary,
};

/** From this many columns on, a side lays them out in as many columns as it has room for. */
const MANY = 9;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One side of the model: the columns it reads, or the columns it adds. */
function Side({ side, columns, grouped }: { side: "input" | "output"; columns: Attribute[]; grouped?: boolean }) {
  const adds = side === "output";
  return (
    <section
      className={cn("min-w-0 overflow-hidden rounded-xl border bg-card", adds && "border-kind-model/40")}
      aria-label={adds ? "Output" : "Input"}
      data-model-side={side}>
      <header className={cn("border-b px-3.5 py-2.5", adds ? "border-kind-model/25 bg-kind-model/8" : "bg-muted/50")}>
        <p className={cn("text-xs font-semibold tracking-wider uppercase", adds ? "text-kind-model" : "text-muted-foreground")}>{adds ? "Output" : "Input"}</p>
        <p className="text-sm font-medium">
          {adds ? `Adds ${plural(columns.length, "column")} to each row` : `Reads ${plural(columns.length, "column")} from each ${grouped ? "group of rows" : "row"}`}
        </p>
      </header>
      <ul className={cn("px-3.5 py-2", columns.length >= MANY && "gap-x-6 [column-width:12rem]")}>
        {columns.map(c => {
          const Sign = adds ? Plus : (SIGN[c.attributeType] ?? Hash);
          return (
            <li key={c.attributeName} className="flex break-inside-avoid items-center gap-2 py-1" data-model-column={c.attributeName}>
              <Sign className={cn("size-3.5 shrink-0", adds ? "text-kind-model" : "text-muted-foreground/70")} aria-hidden />
              <span className="min-w-0 truncate font-mono text-sm font-medium" title={c.attributeName}>
                {c.attributeName}
              </span>
              <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{c.attributeType}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The way from one part to the next: across where there is room, down where there is not. */
function Way() {
  return (
    <span className="flex items-center justify-center text-muted-foreground/70 @3xl:pt-7" aria-hidden>
      <ArrowRight className="hidden size-5 @3xl:block" />
      <ArrowDown className="size-5 @3xl:hidden" />
    </span>
  );
}

/** A model's contract as a picture: input, model, output. */
export function ModelSignature({ name, contract, className }: { name: string; contract: ModelContract; className?: string }) {
  // A long input gets the room to stand in two columns, so the picture stays about as tall as it is wide.
  const long = contract.inputs.length >= MANY;
  return (
    <div className={cn("@container", className)} data-model-contract>
      <div
        className={cn(
          "grid gap-3 @3xl:items-start",
          long ? "@3xl:grid-cols-[minmax(0,2.2fr)_auto_minmax(0,13rem)_auto_minmax(0,1fr)]" : "@3xl:grid-cols-[minmax(0,1.25fr)_auto_minmax(0,13rem)_auto_minmax(0,1fr)]"
        )}>
        <Side side="input" columns={contract.inputs} grouped={contract.grouped} />
        <Way />
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-kind-model/40 bg-kind-model/8 px-3 py-3.5 text-center" data-model-node>
          <span className="grid size-10 place-items-center rounded-lg bg-kind-model/15 text-kind-model">
            <Box className="size-5" />
          </span>
          <p className="line-clamp-2 text-sm leading-snug font-semibold" title={name}>
            {name}
          </p>
          <p className="text-xs text-muted-foreground">
            {contract.framework} · <span className="font-mono">{contract.entry}</span>
          </p>
          {contract.needs && <p className="text-xs text-muted-foreground">Needs {contract.needs}</p>}
        </div>
        <Way />
        <Side side="output" columns={contract.outputs} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        In a workflow, the <span className="font-mono">predict</span> operator applies it: every {contract.grouped ? "group" : "row"} must have the input's columns, and
        comes out with the output's columns added.
      </p>
    </div>
  );
}

/** How many names a card's line shows before it says how many more there are. */
const NAMED = 4;

/** The same contract in two lines, for a card: what it reads, what it adds. */
export function SignatureLines({ contract, className }: { contract: ModelContract; className?: string }) {
  const line = (label: string, columns: Attribute[], adds: boolean) => (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className={cn("w-12 shrink-0 text-2xs font-semibold tracking-wider uppercase", adds ? "text-kind-model" : "text-muted-foreground")}>{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs" title={columns.map(c => c.attributeName).join(", ")}>
        {columns
          .slice(0, NAMED)
          .map(c => c.attributeName)
          .join(", ")}
        {columns.length > NAMED && <span className="font-sans text-muted-foreground"> and {columns.length - NAMED} more</span>}
      </dd>
    </div>
  );
  return (
    <dl className={cn("grid gap-1 px-3 py-2", className)} data-model-signature>
      {line("Reads", contract.inputs, false)}
      {line("Adds", contract.outputs, true)}
    </dl>
  );
}
