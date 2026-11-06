import { ResourceHeader, usePanelStack } from "@texera/ui";
import type { ReactNode } from "react";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
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
  const { expand } = useOpenResource();
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
      onBack={depth > 1 ? back : undefined}
      onExpand={() => expand(ref)}
      onClose={close}
    />
  );
}

/** A name that edits in place: blur or Enter saves, Escape restores. */
export function EditableName({ value, onChange, disabled, label }: { value: string; onChange: (name: string) => void; disabled?: boolean; label: string }) {
  return (
    <input
      aria-label={label}
      key={value}
      defaultValue={value}
      disabled={disabled}
      onBlur={e => {
        const next = e.target.value.trim();
        if (next && next !== value) onChange(next);
        else e.target.value = value;
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
