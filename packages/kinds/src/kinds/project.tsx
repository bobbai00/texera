import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { FolderKanban, LayoutList } from "lucide-react";
import { ResourceTable } from "../library/ResourceTable";
import { searchQuery } from "../queries";
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

export const projectKind: KindSpec = {
  kind: "project",
  label: "Project",
  plural: "Projects",
  icon: FolderKanban,
  accent: "bg-kind-project/12 text-kind-project",
  tabs: [{ value: "contents", label: "Contents", icon: LayoutList, Component: Contents }],
  defaultSpec: () => ({}),
};
