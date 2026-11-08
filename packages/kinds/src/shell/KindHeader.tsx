import { ResourceHeader, usePanelStack } from "@texera/ui";
import type { ReactNode } from "react";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { useViewHost } from "./host";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";
import { Presence } from "./Presence";
import { ShareButton } from "./Share";

/** The header of a kind's panel or page, wired to the panel stack and the router. */
export function KindHeader({
  ref,
  mode,
  name,
  meta,
  actions,
}: {
  ref: ResourceRef;
  mode: "panel" | "page";
  name: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const depth = usePanelStack(s => s.stack.length);
  const back = usePanelStack(s => s.back);
  const close = usePanelStack(s => s.close);
  const { page } = useOpenResource();
  // Inside a host (the graph beside a chat) the host goes back and away; the header only opens the page.
  const hosted = !!useViewHost();
  return (
    <ResourceHeader
      icon={<KindIcon kind={ref.kind} className="size-7" />}
      kindLabel={KINDS[ref.kind].label}
      name={name}
      meta={meta}
      // Whoever has the resource's page open is on it, and sees who else is: at the top right,
      // beside sharing, however much the page's own actions take.
      actions={
        <>
          {actions}
          {mode === "page" && ref.rid && <Presence rid={ref.rid} />}
          {mode === "page" && ref.rid && <ShareButton ref={ref} />}
        </>
      }
      mode={mode}
      onBack={!hosted && depth > 1 ? back : undefined}
      onExpand={() => page(ref)}
      onClose={hosted ? undefined : close}
    />
  );
}

/**
 * A name that edits in place: blur or Enter saves, Escape restores. A save that `onChange`
 * says failed (a rejected promise) puts the name back, so a refused rename is not left on screen.
 */
export function EditableName({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (name: string) => void | Promise<unknown>;
  disabled?: boolean;
  label: string;
}) {
  return (
    <input
      aria-label={label}
      key={value}
      defaultValue={value}
      disabled={disabled}
      onBlur={e => {
        const input = e.currentTarget;
        const next = input.value.trim();
        if (!next || next === value) {
          input.value = value;
          return;
        }
        const saving = onChange(next);
        if (saving instanceof Promise)
          saving.catch(() => {
            input.value = value;
          });
      }}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      className="block w-full truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-accent/50 disabled:opacity-100"
      data-resource-name
    />
  );
}
