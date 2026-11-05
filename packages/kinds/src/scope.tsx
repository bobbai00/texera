// The project a person works in. Lists show it with what it inherits (the platform's
// built-ins), and what is made goes into it. It is the person's home project until they pick
// another; the pick is kept in their preferences, so it follows them. Inside a resource's own
// page (a workflow's editor, a chat) the scope is that resource's project: its pickers list
// what it can use, wherever the person is working.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { meUpdatePreferences } from "@texera/catalog-client";
import type { Me, Resource } from "@texera/catalog-client/types";
import { createContext, type ReactNode, use } from "react";
import { unwrap } from "./api";
import { meQuery, searchQuery } from "./queries";

/** The pick that lifts the scope: every project the person may read. */
export const ALL_PROJECTS = "all";

type Person = Pick<Me, "homeProject" | "systemProject" | "preferences">;

/**
 * The project a person works in: their pick when it is a project they can still read and work
 * in, else their home. `ALL_PROJECTS` lifts the scope. Undefined until the person is known.
 */
export function workingProject(me: Person | undefined, readable: string[]): string | undefined {
  if (!me) return undefined;
  const picked = me.preferences.project;
  if (picked === ALL_PROJECTS) return ALL_PROJECTS;
  return typeof picked === "string" && picked !== me.systemProject && readable.includes(picked) ? picked : me.homeProject;
}

/** How the app names a working project. */
export function projectLabel(project: string, me: Person | undefined, name: string | undefined): string {
  if (project === ALL_PROJECTS) return "All projects";
  if (project === me?.homeProject) return "Personal";
  return name ?? "a project";
}

/** The projects the person may read. */
export const projectsQuery = () => ({ ...searchQuery({ kind: "project", limit: 200 }), staleTime: 60_000 });

const ProjectScopeContext = createContext<string | undefined>(undefined);

/** Scopes what is inside to one project: a resource's own. */
export function ProjectScope({ project, children }: { project: string | undefined; children: ReactNode }) {
  return <ProjectScopeContext value={project}>{children}</ProjectScopeContext>;
}

/** The person's working project, the ones they can pick, and how to pick one. */
export function useWorkingProject() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery());
  const { data: projects } = useQuery(projectsQuery());
  const readable: Resource[] = projects?.items ?? [];
  const current = workingProject(
    me,
    readable.map(p => p.metadata.rid)
  );
  const pick = useMutation({
    mutationFn: async (project: string) => {
      if (!me) return;
      await unwrap(meUpdatePreferences({ body: { ...me.preferences, project } }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQuery().queryKey }),
  });
  return {
    current,
    label: current === undefined ? "" : projectLabel(current, me, readable.find(p => p.metadata.rid === current)?.metadata.name),
    /** What can be picked: the person's home first, then the others; never the platform's own. */
    choices: me
      ? [
          { value: me.homeProject, label: projectLabel(me.homeProject, me, undefined) },
          ...readable.filter(p => p.metadata.rid !== me.homeProject && p.metadata.rid !== me.systemProject).map(p => ({ value: p.metadata.rid, label: p.metadata.name })),
          { value: ALL_PROJECTS, label: projectLabel(ALL_PROJECTS, me, undefined) },
        ]
      : [],
    pick: (project: string) => pick.mutate(project),
  };
}

/**
 * The project lists are scoped to and new resources go into: the resource's own inside its
 * page, else the person's working project. Undefined narrows nothing, and what is made then
 * goes to the person's home.
 */
export function useScope(): string | undefined {
  const inside = use(ProjectScopeContext);
  const { current } = useWorkingProject();
  if (inside) return inside;
  return current === ALL_PROJECTS ? undefined : current;
}
