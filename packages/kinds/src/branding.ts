// How the app looks: the look of the project the person works in, as the project has it or
// inherits it up its chain; Texera's while every project is in view. A project's admins give it
// a look of its own, and the projects that inherit from it wear it unless they set their own.

import { useQuery } from "@tanstack/react-query";
import { lookOf, MARK } from "@texera/ui";
import { useEffect } from "react";
import { meQuery, projectSettingsQuery } from "./queries";
import { ALL_PROJECTS, useWorkingProject } from "./scope";

/** What the app is called and looks like; empty until the catalog has said. */
export interface Look {
  name: string;
  /** The logo beside the name. */
  logoUrl?: string;
  /** The logo shown large. */
  logoLargeUrl?: string;
}

/** The look of the project the person works in. */
export function useLook(): Look {
  const { data: me } = useQuery(meQuery());
  const { current } = useWorkingProject();
  const project = current === undefined || current === ALL_PROJECTS ? me?.rootProject : current;
  const { data } = useQuery({ ...projectSettingsQuery(project ?? ""), enabled: !!project });
  return data ? lookOf(data.branding) : { name: "" };
}

/** Has the browser say the look too: the tab's title and icon. */
export function useDocumentLook(): void {
  const { name, logoUrl } = useLook();
  useEffect(() => {
    if (name) document.title = name;
    if (!logoUrl) return;
    for (const icon of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
      // A project with no logo of its own keeps the app's icons.
      icon.dataset.shipped ??= icon.href;
      icon.href = logoUrl === MARK ? icon.dataset.shipped : logoUrl;
    }
  }, [name, logoUrl]);
}
