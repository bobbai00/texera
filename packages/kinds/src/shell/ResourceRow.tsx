// What a row of a list says of a resource besides what it is: its name, which can be changed where
// it stands, and small labels for who can see it and whose it is.

import { useQuery } from "@tanstack/react-query";
import type { Resource, ResourceMetadata } from "@texera/catalog-client/types";
import { ErrorNote } from "@texera/ui";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { meQuery } from "../queries";
import { PrincipalName } from "./Chips";
import { nameKeys, useRename } from "./rename";

const LABEL = "rounded border bg-background px-1.5 py-px text-xs whitespace-nowrap text-muted-foreground";

/** Whose a resource is, to the person looking: theirs, or who made it. */
export function OwnerTag({ metadata, className }: { metadata: ResourceMetadata; className?: string }) {
  const { data: me } = useQuery(meQuery());
  const mine = me?.principal.pid === metadata.owner;
  return (
    <span className={className} data-owned-by-me={mine ? "true" : undefined}>
      {mine ? (
        "Owned by me"
      ) : (
        <>
          Created by <PrincipalName pid={metadata.createdBy} />
        </>
      )}
    </span>
  );
}

/** Who can see a resource and whose it is. */
export function ResourceLabels({ metadata }: { metadata: ResourceMetadata }) {
  const { data: me } = useQuery(meQuery());
  // What Texera holds is open to everyone.
  const open = metadata.visibility === "public" || metadata.project === me?.rootProject;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className={LABEL} data-visibility={open ? "public" : "private"}>
        {open ? "Public" : "Private"}
      </span>
      <OwnerTag metadata={metadata} className={LABEL} />
    </span>
  );
}

/** A resource's name in a row: a click opens it, and whoever may change it gets a pencil on hover. */
export function RowName({ resource, editable, onOpen }: { resource: Resource; editable: boolean; onOpen: () => void }) {
  const { rid, name, etag } = resource.metadata;
  const [editing, setEditing] = useState(false);
  const rename = useRename(rid, etag);
  if (editing)
    return (
      <span className="grid min-w-48 flex-1 gap-1">
        <input
          // biome-ignore lint/a11y/noAutofocus: the person just asked to change this name
          autoFocus
          defaultValue={name}
          aria-label={`New name for ${name}`}
          onClick={e => e.stopPropagation()}
          onFocus={e => e.currentTarget.select()}
          onBlur={e => {
            const next = e.currentTarget.value.trim();
            if (next && next !== name) rename.mutate(next, { onSuccess: () => setEditing(false) });
            else setEditing(false);
          }}
          onKeyDown={nameKeys(name)}
          className="w-full rounded border bg-background px-1.5 py-0.5 text-sm font-medium outline-none focus:ring-2 focus:ring-ring/30"
          data-rename-input={rid}
        />
        {rename.error && <ErrorNote error={rename.error} prefix="Could not rename" />}
      </span>
    );
  return (
    <span className="flex w-60 min-w-0 shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onOpen();
        }}
        className="min-w-0 truncate text-left text-sm font-medium hover:underline"
        title={name}>
        {name}
      </button>
      {editable && (
        <button
          type="button"
          aria-label={`Rename ${name}`}
          title="Rename"
          onClick={e => {
            e.stopPropagation();
            setEditing(true);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
          data-rename={rid}>
          <Pencil className="size-3.5" />
        </button>
      )}
    </span>
  );
}
