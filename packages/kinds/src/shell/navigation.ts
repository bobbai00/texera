// How a kind opens elsewhere: beside the page (the panel stack) or as the full page.

import { useNavigate } from "@tanstack/react-router";
import { usePanelStack } from "@texera/ui";
import { useCallback } from "react";
import { href } from "../registry";
import type { ResourceRef } from "../types";

export function useOpenResource() {
  const navigate = useNavigate();
  const open = usePanelStack(s => s.open);
  const close = usePanelStack(s => s.close);
  const beside = useCallback((ref: ResourceRef) => open(ref), [open]);
  const expand = useCallback(
    (ref: ResourceRef) => {
      close();
      void navigate({ to: href(ref) });
    },
    [close, navigate]
  );
  return { beside, expand };
}
