// The names of what wrote a message, by URI, for labels in the chat: an agent's version, a
// model endpoint.

import { useQueries } from "@tanstack/react-query";
import { baseUri, refOf, resourceByUriQuery, versionOf } from "@texera/kinds";
import { useMemo } from "react";

export interface ResourceLabel {
  name: string;
  vno?: number;
  rid: string;
}

/** Resolves resource URIs (with or without `@vno`) to their names; unknown ones get a placeholder. */
export function useResourceLabels(uris: string[], unknown = "agent"): Map<string, ResourceLabel> {
  const bases = useMemo(() => [...new Set(uris.map(baseUri))], [uris]);
  const results = useQueries({ queries: bases.map(uri => ({ ...resourceByUriQuery(uri), staleTime: 5 * 60_000 })) });
  return useMemo(() => {
    const names = new Map<string, string>();
    bases.forEach((uri, i) => {
      const name = results[i]?.data?.metadata.name;
      if (name) names.set(uri, name);
    });
    const out = new Map<string, ResourceLabel>();
    for (const uri of uris) {
      const rid = refOf(uri)?.rid ?? "";
      out.set(uri, { name: names.get(baseUri(uri)) ?? unknown, vno: versionOf(uri), rid });
    }
    return out;
  }, [uris, bases, results, unknown]);
}
