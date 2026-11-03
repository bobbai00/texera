import { useEffect, useState, useSyncExternalStore } from "react";
import { acquireRunner, IDLE_SNAPSHOT, releaseRunner, type WorkflowRunner } from "./engine";

const noSubscription = () => () => {};
const idle = () => IDLE_SNAPSHOT;

/**
 * The live run of a workflow on a unit: connects while the view is mounted and shares
 * the connection with other views of the same workflow on the same unit.
 */
export function useWorkflowRun(workflowRid: string | undefined, unitRid: string | undefined) {
  const [runner, setRunner] = useState<WorkflowRunner>();
  useEffect(() => {
    if (!workflowRid || !unitRid) return;
    const r = acquireRunner(unitRid, workflowRid);
    setRunner(r);
    return () => {
      setRunner(undefined);
      releaseRunner(r);
    };
  }, [workflowRid, unitRid]);
  const snapshot = useSyncExternalStore(runner?.subscribe ?? noSubscription, runner?.getSnapshot ?? idle);
  return { runner, snapshot };
}
