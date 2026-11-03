import { createFileRoute, notFound } from "@tanstack/react-router";
import { kindBySlug, ResourceView } from "@texera/kinds";
import { EmptyState } from "@texera/ui";

// One route for every resource page (/w/<rid>, /d/<rid>, /x/<eid>, ...): the registry picks
// the kind's page by its slug. `vno` pins the page to one version.
export const Route = createFileRoute("/_app/$seg/$rid")({
  validateSearch: (search: Record<string, unknown>): { vno?: number } => {
    const n = Number(search.vno);
    return { vno: search.vno !== undefined && Number.isInteger(n) && n > 0 ? n : undefined };
  },
  loader: ({ context: { queryClient }, params }) => {
    const spec = kindBySlug(params.seg);
    if (!spec) throw notFound();
    void spec.prefetch?.(queryClient, { kind: spec.kind, rid: params.rid });
  },
  component: ResourcePage,
});

function ResourcePage() {
  const { seg, rid } = Route.useParams();
  const { vno } = Route.useSearch();
  const spec = kindBySlug(seg);
  if (!spec) return <EmptyState className="py-20">This page does not exist.</EmptyState>;
  return <ResourceView key={`${spec.kind}:${rid}:${vno ?? ""}`} ref={{ kind: spec.kind, rid, vno }} mode="page" />;
}
