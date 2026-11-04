import { useNavigate, useSearch } from "@tanstack/react-router";
import { usePanelStack } from "@texera/ui";
import { useEffect } from "react";

/**
 * Keeps the panel stack and the URL's `panel` search parameter in step, both ways: a link
 * with `?panel=datasets/<rid>@2` opens that panel, and opening a panel updates the link.
 */
export function PanelSync() {
  const { panel } = useSearch({ from: "/_app" });
  const navigate = useNavigate();
  const stack = usePanelStack(s => s.stack);
  const set = usePanelStack(s => s.set);
  const top = stack.at(-1);

  // URL → store: reacts to the URL only, so a store change does not bounce back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (panel === top) return;
    set(panel ? [panel] : []);
  }, [panel]);

  // Store → URL: reacts to the stack only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (top === panel) return;
    void navigate({ to: ".", search: prev => ({ ...prev, panel: top }), replace: true });
  }, [top]);

  return null;
}
