import { queryOptions } from "@tanstack/react-query";
import { workflowsReadRows } from "@texera/catalog-client";
import type { Execution, ExecutionStatus, Resource } from "@texera/catalog-client/types";
import { unwrap } from "../api";
import { resourceQuery } from "../queries";

export const LIVE = new Set<ExecutionStatus["phase"]>(["pending", "provisioning", "running", "paused"]);

export const isLive = (x: Resource | undefined) =>
  x !== undefined && LIVE.has((x.status as ExecutionStatus | undefined)?.phase ?? "pending");

/**
 * An execution. The generic read serves it and its parent is the workflow; its page watches it
 * (useWatch), so the poll while it runs is only a fallback for a dropped stream.
 */
export const executionQuery = (eid: string) => ({
  ...resourceQuery(eid),
  select: (r: Resource) => r as unknown as Execution,
  refetchInterval: (query: { state: { data?: Resource } }) => (isLive(query.state.data) ? 10_000 : false),
});

export const PAGE_SIZE = 50;

/**
 * A page of a port's rows. What a finished execution wrote does not change, so it is read
 * once. While the execution goes, the port fills: `soFar` is how many rows it has reported,
 * and the page is read again when that moves.
 */
export const rowsQuery = (
  workflow: string,
  eid: string,
  operatorID: string,
  portID: string,
  page: number,
  soFar?: number
) =>
  queryOptions({
    queryKey: ["rows", eid, operatorID, portID, page, soFar ?? "written"],
    queryFn: () =>
      unwrap(
        workflowsReadRows({
          path: { rid: workflow, eid, operatorID, portID },
          query: { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE },
        })
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
