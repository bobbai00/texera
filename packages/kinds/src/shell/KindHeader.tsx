import { ResourceHeader, usePanelStack } from "@texera/ui";
import { Pencil } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { DeleteButton } from "./Delete";
import { useViewHost } from "./host";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";
import { nameKeys } from "./rename";
import { Presence } from "./Presence";
import { ShareButton } from "./Share";

/** The header of a kind's panel or page, wired to the panel stack and the router. */
export function KindHeader({
  ref,
  mode,
  name,
  meta,
  actions,
  deletable = true,
}: {
  ref: ResourceRef;
  mode: "panel" | "page";
  name: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** False while the thing cannot go (an execution still going): the header then offers no delete. */
  deletable?: boolean;
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
      // After the kind's own actions, the same on every header: delete, for whoever may; then, on
      // the resource's page, who else has it open, and sharing.
      actions={
        <>
          {actions}
          {deletable && ref.rid && <DeleteButton ref={ref} />}
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
  const input = useRef<HTMLInputElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  return (
    <span className="group/name flex max-w-full min-w-0 items-center gap-1">
      {/* The name's own width, so the pencil stands right after it. */}
      <span className="inline-grid min-w-0">
        <span ref={sizer} aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden text-sm font-semibold whitespace-pre">
          {value}
        </span>
        <input
          ref={input}
          aria-label={label}
          key={value}
          defaultValue={value}
          disabled={disabled}
          onInput={e => {
            if (sizer.current) sizer.current.textContent = e.currentTarget.value;
          }}
          onBlur={e => {
            const field = e.currentTarget;
            const next = field.value.trim();
            if (!next || next === value) {
              field.value = value;
              if (sizer.current) sizer.current.textContent = value;
              return;
            }
            const saving = onChange(next);
            if (saving instanceof Promise)
              saving.catch(() => {
                field.value = value;
                if (sizer.current) sizer.current.textContent = value;
              });
          }}
          onKeyDown={nameKeys(value)}
          className="col-start-1 row-start-1 block w-full min-w-8 truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-accent/50 disabled:opacity-100"
          data-resource-name
        />
      </span>
      {!disabled && (
        <button
          type="button"
          aria-label="Rename"
          title="Rename"
          onClick={() => {
            input.current?.focus();
            input.current?.select();
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100 hover:text-foreground focus-visible:opacity-100">
          <Pencil className="size-3.5" />
        </button>
      )}
    </span>
  );
}
