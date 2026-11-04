import { createFileRoute, notFound } from "@tanstack/react-router";
import { kindOfPlural, Library } from "@texera/kinds";
import { EmptyState } from "@texera/ui";

/** The library of one kind, by the contract's plural: /workflows, /agent-templates, ... */
export const Route = createFileRoute("/_app/$plural")({
  loader: ({ params }) => {
    if (!kindOfPlural(params.plural)) throw notFound();
  },
  component: LibraryPage,
});

function LibraryPage() {
  const { plural } = Route.useParams();
  const kind = kindOfPlural(plural);
  if (!kind) return <EmptyState className="py-20">Unknown library section.</EmptyState>;
  return <Library key={kind} kind={kind} />;
}
