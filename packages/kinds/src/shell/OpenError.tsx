import { ErrorNote } from "@texera/ui";
import { Lock } from "lucide-react";
import { CatalogError } from "../api";
import { KINDS } from "../registry";
import type { KindId } from "../types";

/** Whether a page cannot be shown because the person may not read it, or because it is not there. */
export function whyNot(error: unknown): "forbidden" | "not_found" | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  const status = error instanceof CatalogError ? error.status : undefined;
  if (code === "forbidden" || status === 403) return "forbidden";
  if (code === "not_found" || status === 404) return "not_found";
  return undefined;
}

/**
 * Why a resource's page cannot be shown. A link to something that was not shared with the
 * person is not a failure to report: the page says what it is and what to do.
 */
export function OpenError({ error, kind }: { error: unknown; kind: KindId }) {
  const label = KINDS[kind].label.toLowerCase();
  const why = whyNot(error);
  if (!why) return <ErrorNote error={error} prefix={`Could not open this ${label}`} className="m-4" />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-20 text-center" data-cannot-open={why}>
      <Lock className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{why === "forbidden" ? `This ${label} has not been shared with you` : `This ${label} does not exist`}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {why === "forbidden" ? "Ask its owner to share it with you, then open this link again." : "It may have been deleted, or the link is not right."}
      </p>
    </div>
  );
}
