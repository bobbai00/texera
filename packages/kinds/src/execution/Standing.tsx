// Where an execution stands, said in a few words beside what shows it: its phase, and while it
// goes how far it has gone and for how long.

import type { Execution } from "@texera/catalog-client/types";
import { Badge, formatDuration } from "@texera/ui";
import { Loader2 } from "lucide-react";
import { LIVE } from "./queries";

export function Standing({ execution }: { execution: Execution }) {
  const status = execution.status;
  const phase = status?.phase ?? "pending";
  const operators = Object.values(status?.operators ?? {});
  const done = operators.filter(o => o.state.toLowerCase() === "completed").length;
  const going = LIVE.has(phase);
  const progress = going
    ? [operators.length ? `${done} of ${operators.length} done` : "", formatDuration(status?.startedAt, undefined)]
    : [];
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={`${execution.metadata.name}: ${phase}`}
      data-latest-execution={phase}
      data-execution={execution.metadata.rid}>
      <Badge
        tone={phase === "completed" ? "success" : phase === "failed" || phase === "cancelled" ? "danger" : "warning"}
        className="capitalize">
        {going && phase !== "paused" && <Loader2 className="size-3 animate-spin" />}
        {phase}
      </Badge>
      {going && (
        <span className="hidden max-w-56 truncate tabular-nums md:inline" data-execution-progress>
          {progress.filter(Boolean).join(" · ")}
        </span>
      )}
    </span>
  );
}
