// How the app looks: the look of the project the person works in, as the project has it or
// inherits it up its chain; Texera's while every project is in view. A project's admins give it
// a look of its own, and the projects that inherit from it wear it unless they set their own.

import { useQuery } from "@tanstack/react-query";
import { meQuery, projectSettingsQuery } from "./queries";
import { ALL_PROJECTS, useWorkingProject } from "./scope";

export interface Look {
  name: string;
  logoUrl?: string;
}

/** The look of the project the person works in. */
export function useLook(): Look {
  const { data: me } = useQuery(meQuery());
  const { current } = useWorkingProject();
  const project = current === undefined || current === ALL_PROJECTS ? me?.rootProject : current;
  const { data } = useQuery({ ...projectSettingsQuery(project ?? ""), enabled: !!project });
  return { name: data?.branding.name || "Texera", ...(data?.branding.logoUrl ? { logoUrl: data.branding.logoUrl } : {}) };
}
