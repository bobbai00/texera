import { createFileRoute } from "@tanstack/react-router";
import { kindByLibrarySlug, Library } from "@texera/kinds";
import { EmptyState } from "@texera/ui";

export const Route = createFileRoute("/_app/library/$kind")({ component: LibraryPage });

function LibraryPage() {
  const { kind } = Route.useParams();
  const spec = kindByLibrarySlug(kind);
  if (!spec) return <EmptyState className="py-20">Unknown library section.</EmptyState>;
  return <Library key={spec.kind} kind={spec.kind} />;
}
