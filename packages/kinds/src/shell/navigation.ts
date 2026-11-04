// How a kind opens elsewhere: beside the page (the panel stack) or as the full page. The
// panel stack holds paths (`datasets/{rid}@2`), the same text the URL carries.

import { useNavigate } from "@tanstack/react-router";
import { usePanelStack } from "@texera/ui";
import { useCallback } from "react";
import type { ResourceRef } from "../types";
import { href, parsePath, pathOf } from "../uri";

export function useOpenResource() {
  const navigate = useNavigate();
  const open = usePanelStack(s => s.open);
  const close = usePanelStack(s => s.close);
  const beside = useCallback((ref: ResourceRef) => open(pathOf(ref)), [open]);
  const expand = useCallback(
    (ref: ResourceRef) => {
      close();
      void navigate({ to: href(ref) });
    },
    [close, navigate]
  );
  return { beside, expand };
}

/** The ref a panel entry names, if it is well formed. */
export const panelRef = (entry: string | undefined): ResourceRef | undefined => (entry ? parsePath(entry)?.ref : undefined);
