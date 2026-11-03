import { executionsReadOptions, executionsResultOptions } from "@texera/catalog-client/query";
import type { Execution } from "@texera/catalog-client/types";

const LIVE = new Set<Execution["status"]>(["pending", "running"]);

/** An execution, polled while it runs. */
export const executionQuery = (eid: string) => ({
  ...executionsReadOptions({ path: { eid } }),
  refetchInterval: (query: { state: { data?: Execution } }) => (query.state.data && LIVE.has(query.state.data.status) ? 2000 : false),
});

export const PAGE_SIZE = 50;

export const resultQuery = (eid: string, opid: string, port: string, page: number) =>
  executionsResultOptions({ path: { eid, opid, port }, query: { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE } });
