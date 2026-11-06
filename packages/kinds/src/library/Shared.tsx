import { useQuery } from "@tanstack/react-query";
import { ErrorNote } from "@texera/ui";
import { Users } from "lucide-react";
import { searchQuery } from "../queries";
import { ResourceTable } from "./ResourceTable";

/**
 * What other people shared with the person: projects, chats, workflows, datasets and the rest,
 * in one list wherever they live. A project that was shared is also one of the projects to
 * work in; a single thing that was shared is found here.
 */
export function SharedWithMe() {
  const { data, isPending, error } = useQuery(searchQuery({ shared: true, limit: 200 }));
  return (
    <div className="scrollbar-thin h-full overflow-y-auto" data-shared-with-me>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Users className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Shared with me</h1>
            <p className="text-sm text-muted-foreground">What other people shared with you, in whatever project it lives.</p>
          </div>
        </header>
        {error ? <ErrorNote error={error} prefix="Could not list what was shared with you" /> : <ResourceTable resources={data?.items} loading={isPending} empty="Nothing has been shared with you yet." />}
      </div>
    </div>
  );
}
