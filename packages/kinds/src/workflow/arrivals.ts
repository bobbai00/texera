// Operators that arrive on a canvas from elsewhere: added by the agent, or by another person.
// Each is pointed out for a moment and brought into view, so what was added is seen where it went.

import type { WorkflowSpec } from "@texera/workflow-model";
import { useEffect, useRef, useState } from "react";

/** How long an operator that arrived is pointed out. */
const POINTED_OUT_FOR = 4000;

/** The operators of `ids` the canvas had not seen and did not add itself. */
export function arrivedFrom(seen: ReadonlySet<string>, ids: readonly string[], mine: ReadonlySet<string>): string[] {
  return ids.filter(id => !seen.has(id) && !mine.has(id));
}

/**
 * The operators that arrived from elsewhere a moment ago. `mine` names the ones this canvas
 * added; `onArrive` is told of the others as they come. What the canvas opened with arrived from
 * nowhere.
 */
export function useArrivals(
  spec: WorkflowSpec,
  mine: ReadonlySet<string>,
  onArrive: (ids: string[]) => void
): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef<number[]>([]);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const ids = spec.operators.map(o => o.operatorID);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = arrivedFrom(seen.current, ids, mine);
    for (const id of ids) seen.current.add(id);
    if (fresh.length === 0) return;
    setArrived(was => new Set([...was, ...fresh]));
    onArrive(fresh);
    timers.current.push(
      window.setTimeout(() => setArrived(was => new Set([...was].filter(id => !fresh.includes(id)))), POINTED_OUT_FOR)
    );
  }, [spec, mine, onArrive]);
  return arrived;
}
