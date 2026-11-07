// What the lineage graph asks the catalog beside the arrows themselves: what each named
// resource is, and which executions of a workflow still exist.

import { workflowsListExecutionsOptions } from "@texera/catalog-client/query";
import { resourceByUriQuery } from "../queries";
import { whyNot } from "../shell/OpenError";

/**
 * The resource a card names. One that is gone or not shared stays so however often it is
 * asked for, so only another kind of failure is tried again, and a card drawn again does not
 * ask again: the graph asks once each time it is opened.
 */
export const namedQuery = (uri: string) => ({
  ...resourceByUriQuery(uri),
  retry: (failures: number, error: unknown) => whyNot(error) === undefined && failures < 2,
});

/** The same, for a card: drawing it never asks again for what the graph already has. */
export const cardNameQuery = (uri: string) => ({ ...namedQuery(uri), retryOnMount: false });

/** The executions of a workflow the catalog still has: what a card says of one, and which version it ran. */
export const executionsQuery = (workflow: string) => ({
  ...workflowsListExecutionsOptions({ path: { rid: workflow }, query: { limit: 200 } }),
  staleTime: 30_000,
  retry: false,
});
