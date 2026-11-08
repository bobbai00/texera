// How a kind opens elsewhere: beside the page (the panel stack) or as the full page. The
// panel stack holds paths (`datasets/{rid}@2`), the same text the URL carries. Inside a host
// (the graph beside a chat), both open in the host instead, so the page stays as it is; `page`
// always goes to the full page.

import { useNavigate } from "@tanstack/react-router";
import { usePanelStack } from "@texera/ui";
import { useCallback } from "react";
import type { ResourceRef } from "../types";
import { href, parsePath, pathOf } from "../uri";
import { useViewHost } from "./host";

export function useOpenResource() {
  const navigate = useNavigate();
  const open = usePanelStack(s => s.open);
  const close = usePanelStack(s => s.close);
  const host = useViewHost();
  const page = useCallback(
    (ref: ResourceRef) => {
      close();
      void navigate({ to: href(ref) });
    },
    [close, navigate]
  );
  const beside = useCallback((ref: ResourceRef) => (host ? host.open(ref) : open(pathOf(ref))), [host, open]);
  const expand = useCallback((ref: ResourceRef) => (host ? host.open(ref) : page(ref)), [host, page]);
  return { beside, expand, page };
}

/** The ref a panel entry names, if it is well formed. */
export const panelRef = (entry: string | undefined): ResourceRef | undefined =>
  entry ? parsePath(entry)?.ref : undefined;
