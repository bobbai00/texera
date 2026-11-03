import { ResourceHeader, usePanelStack } from "@texera/ui";
import type { ReactNode } from "react";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { KindIcon } from "./KindIcon";
import { useOpenResource } from "./navigation";

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
      actions={actions}
      mode={mode}
      onBack={depth > 1 ? back : undefined}
      onExpand={() => expand(ref)}
      onClose={close}
    />
  );
}
