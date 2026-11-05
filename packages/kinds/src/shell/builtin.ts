// What the platform ships. One rule says what is built in: the resource lives in the
// platform's project. Everyone can view and use a built-in; it changes with a release, so the
// app shows it without the controls that would change it.

import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { useCallback } from "react";
import { meQuery } from "../queries";

/** Tells whether a resource is built in. False until the caller's projects are known. */
export function useIsBuiltIn(): (resource: Pick<Resource, "metadata">) => boolean {
  const { data: me } = useQuery(meQuery());
  const platform = me?.systemProject;
  return useCallback(resource => platform !== undefined && resource.metadata.project === platform, [platform]);
}
