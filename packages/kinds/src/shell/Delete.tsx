// Deleting a resource, the same wherever it shows: a bin on its header and on its row of a list,
// then one question that says what goes with it. The catalog decides; what it refuses is said in
// the same place, with what stands in the way.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Button, DialogClose, DialogContent, DialogRoot, ErrorNote, Spinner, Tooltip, cn, usePanelStack } from "@texera/ui";
import { AlertTriangle, Trash2 } from "lucide-react";
import { type ReactNode, use, useState } from "react";
import { deleteResource } from "../api";
import { canQuery, isAbout, resourceQuery } from "../queries";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { parsePath } from "../uri";
import { executionsQuery } from "../workflow/queries";
import { UriChip } from "./Chips";
import { goesWith, pageAfter, refusalOf } from "./deleting";
import { useViewHost } from "./host";
import { KindIcon } from "./KindIcon";
import { LookOnly } from "./may";

/**
 * Deletes a resource and leaves no trace of it on screen: the lists are asked again, what was
 * read of it is forgotten, and a view of it is left for where it lived. `here` says the delete
 * was asked from the thing's own view, which inside a host goes back to what the host showed.
 */
function useDelete(ref: ResourceRef, here: boolean) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const host = useViewHost();
  return useMutation({
    mutationFn: async () => {
      // Where it lived is read before it goes.
      const project = queryClient.getQueryData(resourceQuery(ref.rid).queryKey)?.metadata.project;
      await deleteResource(ref.rid);
      return project;
    },
    onSuccess: project => {
      const panels = usePanelStack.getState();
      panels.set(panels.stack.filter(entry => parsePath(entry)?.ref.rid !== ref.rid));
      const to = pageAfter(ref, project, router.state.location.pathname);
      if (here && host) host.back();
      else if (to) void navigate({ to });
      queryClient.removeQueries({ predicate: query => isAbout(query.queryKey, ref.rid) });
      // Whatever listed it, counted it or drew it is asked again.
      void queryClient.invalidateQueries({ predicate: query => !isAbout(query.queryKey, ref.rid) });
    },
  });
}

/** The question a delete asks, and the catalog's answer when it is no. */
function DeleteDialog({ ref, here, onDone }: { ref: ResourceRef; here: boolean; onDone: () => void }) {
  const { data: resource } = useQuery(resourceQuery(ref.rid));
  const { data: executions } = useQuery({ ...executionsQuery(ref.rid), enabled: ref.kind === "workflow" });
  const remove = useDelete(ref, here);
  const spec = KINDS[ref.kind];
  const label = spec.label.toLowerCase();
  const refusal = refusalOf(remove.error);
  const facts = resource ? (spec.facts?.(resource) ?? []) : [];
  const counted = executions && !executions.nextCursor ? executions.items.length : undefined;
  return (
    <DialogContent
      title={`Delete this ${label}?`}
      description="It is removed for everyone who can open it, and cannot be brought back."
      className="max-w-md"
      footer={
        <>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={remove.isPending || !resource}
            onClick={() => remove.mutate(undefined, { onSuccess: onDone })}
            data-delete-confirm>
            {remove.isPending ? <Spinner className="text-white" /> : <Trash2 />} Delete {label}
          </Button>
        </>
      }>
      <div className="space-y-3" data-delete-dialog={ref.kind}>
        <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
          <KindIcon kind={ref.kind} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" data-delete-name>
              {resource?.metadata.name ?? "…"}
            </div>
            <div className="truncate text-xs text-muted-foreground">{[spec.label, ...facts].join(" · ")}</div>
          </div>
        </div>
        {goesWith(ref.kind, counted) && <p className="text-sm text-muted-foreground">{goesWith(ref.kind, counted)}</p>}
        {refusal && (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="alert" data-delete-refused>
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{refusal.said}</span>
            </p>
            {refusal.blockers.length > 0 && (
              // Each opens beside the page; the question gets out of its way.
              // biome-ignore lint/a11y/noStaticElementInteractions: hears the chips' own clicks
              // biome-ignore lint/a11y/useKeyWithClickEvents: a chip is a button, and Enter on it is a click
              <div className="flex flex-wrap gap-1.5 pl-6" onClick={onDone}>
                {refusal.blockers.map(uri => (
                  <UriChip key={uri} uri={uri} emphasis className="bg-background" />
                ))}
              </div>
            )}
          </div>
        )}
        {remove.error && !refusal && <ErrorNote error={remove.error} prefix="Could not delete" />}
      </div>
    </DialogContent>
  );
}

/** Whether the person may delete a resource, as the catalog decides; asked only once `ask` holds. */
function useMayDelete(rid: string, ask = true): boolean {
  const lookOnly = use(LookOnly);
  const { data } = useQuery({ ...canQuery("delete", rid), enabled: ask && !lookOnly });
  return !lookOnly && data === true;
}

/**
 * The bin on a resource's own header: there for whoever may delete it. `here` is true on the
 * thing's own view, which is left once the thing is gone.
 */
export function DeleteButton({ ref, here = true }: { ref: ResourceRef; here?: boolean }) {
  const [open, setOpen] = useState(false);
  const may = useMayDelete(ref.rid);
  const label = `Delete ${KINDS[ref.kind].label.toLowerCase()}`;
  if (!may) return null;
  return (
    <>
      <Tooltip content={label} side="bottom">
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => setOpen(true)} data-delete={ref.kind}>
          <Trash2 />
        </Button>
      </Tooltip>
      <DialogRoot open={open} onOpenChange={setOpen}>
        {open && <DeleteDialog ref={ref} here={here} onDone={() => setOpen(false)} />}
      </DialogRoot>
    </>
  );
}

/**
 * The bin on a resource's row of a list. Whether the person may delete is asked of the catalog
 * once the row is pointed at or reached by the keyboard, so a long list asks nothing until then;
 * the bin's place is kept either way, and the rows stay in line.
 *
 * `row` goes on the row's element (which carries `group/row`), `bin` where the bin stands in it.
 */
export function useRowDelete(ref: ResourceRef): { row: Record<"onPointerEnter" | "onPointerMove" | "onMouseEnter" | "onFocus", () => void>; bin: ReactNode } {
  const [near, setNear] = useState(false);
  const [open, setOpen] = useState(false);
  const may = useMayDelete(ref.rid, near);
  const label = `Delete ${KINDS[ref.kind].label.toLowerCase()}`;
  const reach = () => setNear(true);
  return {
    // Entering is not the only way to be on a row: a row can come up under a pointer at rest
    // (a list drawn again), which the browser tells as a mouse entering or not at all until the
    // pointer next moves.
    row: { onPointerEnter: reach, onPointerMove: reach, onMouseEnter: reach, onFocus: reach },
    bin: (
      // What happens in the bin and its dialog stays there: the row under it opens on a click.
      // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the row from hearing them
      // biome-ignore lint/a11y/useKeyWithClickEvents: the button inside is the keyboard's
      <span className="flex size-6 shrink-0 items-center justify-center" onClick={e => e.stopPropagation()}>
        {may && (
          <button
            type="button"
            aria-label={label}
            title={label}
            onClick={() => setOpen(true)}
            className={cn(
              "rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100",
              open && "opacity-100"
            )}
            data-delete={ref.kind}
            data-delete-row={ref.rid}>
            <Trash2 className="size-3.5" />
          </button>
        )}
        {may && (
          <DialogRoot open={open} onOpenChange={setOpen}>
            {open && <DeleteDialog ref={ref} here={false} onDone={() => setOpen(false)} />}
          </DialogRoot>
        )}
      </span>
    ),
  };
}
