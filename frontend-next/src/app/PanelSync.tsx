import { useNavigate, useSearch } from "@tanstack/react-router";
import { usePanelStack } from "@texera/ui";
import { useEffect, useRef } from "react";

/**
 * Keeps the panel stack and the URL's `panel` search parameter in step, both ways: a link
 * with `?panel=datasets/<rid>@2` opens that panel, and opening a panel updates the link.
 * One ref remembers the last value either side wrote, so a change never bounces back.
 */
export function PanelSync() {
  const { panel } = useSearch({ from: "/_app" });
  const navigate = useNavigate();
  const top = usePanelStack(s => s.stack.at(-1));
  const set = usePanelStack(s => s.set);
  const synced = useRef<string | undefined>(undefined);

  // URL → store, on arrival and whenever the URL changes.
  useEffect(() => {
    if (panel === synced.current) return;
    synced.current = panel;
    set(panel ? [panel] : []);
  }, [panel, set]);

  // Store → URL, reading the live stack so the write above is not undone in the same pass.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the stack only
  useEffect(() => {
    const live = usePanelStack.getState().stack.at(-1);
    if (live === synced.current) return;
    synced.current = live;
    void navigate({ to: ".", search: prev => ({ ...prev, panel: live }), replace: true });
  }, [top]);

  return null;
}
