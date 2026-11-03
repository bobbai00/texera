import { useNavigate, useSearch } from "@tanstack/react-router";
import { parseRef } from "@texera/kinds";
import { panelKey, usePanelStack } from "@texera/ui";
import { useEffect } from "react";

/**
 * Keeps the panel stack and the URL's `panel` search parameter in step, both ways: a link
 * with `?panel=w:<rid>` opens that panel, and opening a panel updates the link.
 */
export function PanelSync() {
  const { panel } = useSearch({ from: "/_app" });
  const navigate = useNavigate();
  const stack = usePanelStack(s => s.stack);
  const set = usePanelStack(s => s.set);
  const top = stack.at(-1);
  const topKey = top ? panelKey(top) : undefined;

  // URL → store: reacts to the URL only, so a store change does not bounce back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (panel === topKey) return;
    const ref = parseRef(panel);
    set(ref ? [ref] : []);
  }, [panel]);

  // Store → URL: reacts to the stack only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (topKey === panel) return;
    void navigate({ to: ".", search: prev => ({ ...prev, panel: topKey }), replace: true });
  }, [topKey]);

  return null;
}
