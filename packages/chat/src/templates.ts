// The names of agent template versions, by URI, for labels in the chat.

import { useQueries } from "@tanstack/react-query";
import { baseUri, refOf, resourceByUriQuery, versionOf } from "@texera/kinds";
import { useMemo } from "react";

export interface TemplateLabel {
  name: string;
  vno?: number;
  rid: string;
}

/** Resolves template URIs (with or without `@vno`) to their names; unknown ones get a placeholder. */
export function useTemplateLabels(uris: string[]): Map<string, TemplateLabel> {
  const bases = useMemo(() => [...new Set(uris.map(baseUri))], [uris]);
  const results = useQueries({ queries: bases.map(uri => ({ ...resourceByUriQuery(uri), staleTime: 5 * 60_000 })) });
  return useMemo(() => {
    const names = new Map<string, string>();
    bases.forEach((uri, i) => {
      const name = results[i]?.data?.metadata.name;
      if (name) names.set(uri, name);
    });
    const out = new Map<string, TemplateLabel>();
    for (const uri of uris) {
      const rid = refOf(uri)?.rid ?? "";
      out.set(uri, { name: names.get(baseUri(uri)) ?? "agent", vno: versionOf(uri), rid });
    }
    return out;
  }, [uris, bases, results]);
}
