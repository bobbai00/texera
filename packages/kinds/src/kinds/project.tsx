import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Badge, Button } from "@texera/ui";
import { Check, FolderKanban, LayoutList } from "lucide-react";
import { ResourceTable } from "../library/ResourceTable";
import { searchQuery } from "../queries";
import { useWorkingProject } from "../scope";
import { useIsBuiltIn } from "../shell/builtin";
import type { KindSpec } from "../types";

/** Everything in the project the caller may read. */
function Contents({ resource }: { resource: Resource }) {
  const { data, isPending } = useQuery(searchQuery({ project: resource.metadata.rid, limit: 200 }));
  return (
    <div className="scrollbar-thin overflow-y-auto p-4">
      <ResourceTable resources={data?.items.filter(r => r.kind !== "project")} loading={isPending} />
    </div>
  );
}

/**
 * Whether the person works in this project, and the one click that makes it so: what they
 * make from then on goes into it. Looking at a project's page does not change where they work.
 */
function Actions({ resource }: { resource: Resource }) {
  const { current, pick } = useWorkingProject();
  const builtIn = useIsBuiltIn()(resource);
  // The platform's own project is nobody's to work in.
  if (current === undefined || builtIn) return null;
  if (current === resource.metadata.rid)
    return (
      <Badge tone="success" data-working-here>
        <Check className="size-3" /> You work here
      </Badge>
    );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void pick(resource.metadata.rid).catch(() => undefined)}
      data-work-here>
      Work in this project
    </Button>
  );
}

export const projectKind: KindSpec = {
  kind: "project",
  label: "Project",
  plural: "Projects",
  icon: FolderKanban,
  accent: "bg-kind-project/12 text-kind-project",
  tabs: [{ value: "contents", label: "Contents", icon: LayoutList, Component: Contents }],
  Actions,
  defaultSpec: () => ({}),
};
