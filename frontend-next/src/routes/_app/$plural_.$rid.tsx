import { createFileRoute, notFound } from "@tanstack/react-router";
import { KINDS, kindOfPlural, ResourceView } from "@texera/kinds";
import { EmptyState } from "@texera/ui";

// One route for every resource page (/workflows/<rid>, /datasets/<rid>, ...): the path is the
// resource's URI without the scheme. `vno` pins the page to one version. The underscore keeps it
// a sibling of the library route, not its child.
export const Route = createFileRoute("/_app/$plural_/$rid")({
  validateSearch: (search: Record<string, unknown>): { vno?: number } => {
    const n = Number(search.vno);
    return { vno: search.vno !== undefined && Number.isInteger(n) && n > 0 ? n : undefined };
  },
  loader: ({ context: { queryClient }, params }) => {
    const kind = kindOfPlural(params.plural);
    if (!kind) throw notFound();
    void KINDS[kind].prefetch?.(queryClient, { kind, rid: params.rid });
  },
  component: ResourcePage,
});

function ResourcePage() {
  const { plural, rid } = Route.useParams();
  const { vno } = Route.useSearch();
  const kind = kindOfPlural(plural);
  if (!kind) return <EmptyState className="py-20">This page does not exist.</EmptyState>;
  return <ResourceView key={`${kind}:${rid}:${vno ?? ""}`} ref={{ kind, rid, vno }} mode="page" />;
}
