import { createFileRoute } from "@tanstack/react-router";
import { ResourceView } from "@texera/kinds";

/** A run, nested under its workflow as its URI is. */
export const Route = createFileRoute("/_app/workflows/$rid/executions/$eid")({ component: ExecutionPage });

function ExecutionPage() {
  const { rid, eid } = Route.useParams();
  return <ResourceView key={eid} ref={{ kind: "execution", rid: eid, parent: rid }} mode="page" />;
}
