// The project a person works in. Lists show it with what it inherits (what the projects up its
// chain hold, Texera's among them), and what the person makes goes into it: a chat, a workflow, anything. With every
// project in view there is no one project to make things in, so the app asks which. It is the
// person's home project until they pick another; the pick is kept in their preferences, so it
// follows them. Inside a resource's own page (a workflow's editor, a chat) what is listed is
// scoped to that resource's project: its pickers show what it can use, wherever the person is
// working.

import { useQuery } from "@tanstack/react-query";
import type { Me, Resource } from "@texera/catalog-client/types";
import { createContext, type ReactNode, use, useState } from "react";
import { useChangePreferences } from "./preferences";
import { meQuery, searchQuery } from "./queries";

/** The pick that lifts the scope: every project the person may read. */
export const ALL_PROJECTS = "all";

type Person = Pick<Me, "homeProject" | "rootProject" | "preferences">;

/**
 * The project a person works in: their pick when it is a project they can still read and work
 * in, else their home. `ALL_PROJECTS` lifts the scope. Undefined until the person is known.
 */
export function workingProject(me: Person | undefined, readable: string[]): string | undefined {
  if (!me) return undefined;
  const picked = me.preferences.project;
  if (picked === ALL_PROJECTS) return ALL_PROJECTS;
  return typeof picked === "string" && readable.includes(picked) ? picked : me.homeProject;
}

/**
 * Where something new goes: the project the person works in. With every project in view the
 * person is asked, starting from what the page suggests (the project of the resource it is
 * about). Nowhere until the working project is known: nothing is made in the meantime.
 */
export function destination(
  working: string | undefined,
  chosen: string | undefined,
  suggested?: string
): { project: string | undefined; asking: boolean } {
  if (working === undefined) return { project: undefined, asking: false };
  if (working !== ALL_PROJECTS) return { project: working, asking: false };
  return { project: chosen ?? suggested, asking: true };
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
  const { data: me } = useQuery(meQuery());
  const { data: projects } = useQuery(projectsQuery());
  const change = useChangePreferences();
  // Until the projects are known, nothing says whether the pick still stands: the working
  // project is unknown, not the person's home.
  const readable: Resource[] | undefined = projects?.items;
  const current = readable
    ? workingProject(
        me,
        readable.map(p => p.metadata.rid)
      )
    : undefined;
  return {
    current,
    label:
      current === undefined
        ? ""
        : projectLabel(current, me, readable?.find(p => p.metadata.rid === current)?.metadata.name),
    /**
     * What can be picked: the person's home first, then the others. Texera, which everyone reads,
     * is there only while it is the pick: its admins work in it from its own page.
     */
    choices:
      me && readable
        ? [
            { value: me.homeProject, label: projectLabel(me.homeProject, me, undefined) },
            ...readable
              .filter(p => p.metadata.rid !== me.homeProject && (p.metadata.rid !== me.rootProject || p.metadata.rid === current))
              .map(p => ({ value: p.metadata.rid, label: p.metadata.name })),
            { value: ALL_PROJECTS, label: projectLabel(ALL_PROJECTS, me, undefined) },
          ]
        : [],
    /** Works in a project from now on. The app follows at once; the catalog keeps the pick. */
    pick: (project: string) => change(p => ({ ...p, project })),
  };
}

/**
 * Where what the person makes here goes, and what to ask them when that is not settled: the
 * projects to choose from, and how to choose. `suggested` is the project a page proposes
 * while every project is in view.
 */
export function useDestination(suggested?: string) {
  const { current, choices } = useWorkingProject();
  const [chosen, setChosen] = useState<string>();
  const { project, asking } = destination(current, chosen, suggested);
  const projects = choices.filter(c => c.value !== ALL_PROJECTS);
  return {
    project,
    /** The project's name as the app says it, once there is one. */
    label: projects.find(c => c.value === project)?.label,
    asking,
    projects,
    choose: setChosen,
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
