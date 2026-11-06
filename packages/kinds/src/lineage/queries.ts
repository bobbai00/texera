// What the lineage graph asks the catalog beside the arrows themselves: what each named
// resource is, and which executions of a workflow still exist.

import { workflowsListExecutionsOptions } from "@texera/catalog-client/query";
import { resourceByUriQuery } from "../queries";
import { whyNot } from "../shell/OpenError";

/**
 * The resource a card names. One that is gone or not shared stays so however often it is
 * asked for, so only another kind of failure is tried again.
 */
export const namedQuery = (uri: string) => ({
  ...resourceByUriQuery(uri),
  retry: (failures: number, error: unknown) => whyNot(error) === undefined && failures < 2,
});

/** The executions of a workflow the catalog still has: what a card says of one, and which version it ran. */
export const executionsQuery = (workflow: string) => ({
  ...workflowsListExecutionsOptions({ path: { rid: workflow }, query: { limit: 200 } }),
  staleTime: 30_000,
  retry: false,
});
