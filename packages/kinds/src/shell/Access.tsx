// Who can do what with a resource: its visibility, and the grants by principal. The
// catalog answers through the authorizer; this only edits the grant tuples. Under each person
// it is shared with, what they cannot open of what it uses (its lineage: what its version
// names), and the one step that opens it to them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesGrant, resourcesRevoke } from "@texera/catalog-client";
import { resourcesNeedsOptions } from "@texera/catalog-client/query";
import type { Principal, Relation, Resource } from "@texera/catalog-client/types";
import { Avatar, Badge, Button, EmptyState, ErrorNote, Input, NativeSelect, SectionTitle, Skeleton } from "@texera/ui";
import { Globe, Loader2, Lock, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { CatalogError, unwrap, updateMetadata } from "../api";
import { grantsQuery, keysOf, principalsQuery } from "../queries";
import { kindEntry } from "../types";
import { PrincipalName } from "./Chips";

const RELATIONS: Relation[] = ["viewer", "editor", "owner", "user"];

/**
 * What a relation is called on a resource of a kind. On a project an owner is one of its admins,
 * who change the project itself, and an editor a member, who works in it.
 */
export function relationLabel(kind: string, relation: Relation): string {
  if (kind === "project") return { owner: "admin", editor: "member", viewer: "viewer", user: "user" }[relation];
  return relation;
}

export function Access({ resource }: { resource: Resource }) {
  return <Grants resource={resource} />;
}

function Grants({ resource }: { resource: Resource }) {
  const rid = resource.metadata.rid;
  const queryClient = useQueryClient();
  const grants = useQuery(grantsQuery(rid));
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListGrants", path: { rid } }] });
    for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
  };
  const visibility = useMutation({
    mutationFn: (v: "public" | "private") => updateMetadata(rid, { visibility: v }, resource.metadata.etag),
    onSuccess: refresh,
  });
  const grant = useMutation({
    mutationFn: ({ pid, relation }: { pid: string; relation: Relation }) => unwrap(resourcesGrant({ path: { rid, pid }, body: { relation } })),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (pid: string) => unwrap(resourcesRevoke({ path: { rid, pid } })),
    onSuccess: refresh,
  });
  const forbidden = grants.error instanceof CatalogError && grants.error.status === 403;
  const isPublic = resource.metadata.visibility === "public";
  // What is shared to be used rather than read: where executions run and where they keep results.
  const used = ["computing-unit", "warehouse"].includes(kindEntry(resource.kind).kind);
  return (
    <div className="space-y-5 p-4" data-access>
      <section className="space-y-2">
        <SectionTitle>Visibility</SectionTitle>
        <div className="flex items-center gap-3">
          <Badge tone={isPublic ? "primary" : "neutral"}>
            {isPublic ? <Globe className="size-3" /> : <Lock className="size-3" />} {isPublic ? "public: everyone can read it" : "private: only people it is shared with"}
          </Badge>
          {!forbidden && (
            <Button variant="outline" size="xs" onClick={() => visibility.mutate(isPublic ? "private" : "public")} disabled={visibility.isPending} data-toggle-visibility>
              {visibility.isPending ? <Loader2 className="animate-spin" /> : null} Make {isPublic ? "private" : "public"}
            </Button>
          )}
        </div>
        {visibility.error && <ErrorNote error={visibility.error} prefix="Could not change visibility" />}
      </section>
      <section className="space-y-2">
        <SectionTitle>Shared with</SectionTitle>
        {forbidden ? (
          <EmptyState className="py-4">Only someone who may share this resource can see or change its grants.</EmptyState>
        ) : grants.error ? (
          <ErrorNote error={grants.error} prefix="Could not load grants" />
        ) : grants.isPending ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <ul className="divide-y rounded-lg border" data-grants>
              {grants.data.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Nobody yet besides the owner.</li>}
              {grants.data.map(g => (
                <li key={`${g.principal}:${g.relation}`} className="space-y-1 px-3 py-2 text-sm" data-grant={g.relation}>
                  <div className="flex items-center gap-2">
                    <PrincipalName pid={g.principal} className="min-w-0 flex-1 truncate" />
                    <Badge>{relationLabel(resource.kind, g.relation)}</Badge>
                    {/* The owner's own grant is the ownership: the catalog does not take it back. */}
                    {g.principal !== resource.metadata.owner && (
                      <Button variant="ghost" size="icon-xs" aria-label="Revoke" onClick={() => revoke.mutate(g.principal)} disabled={revoke.isPending}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                  {/* Someone it is shared with to read it, not to run on it: what they cannot open of what it uses. */}
                  {g.principal !== resource.metadata.owner && g.relation !== "user" && <Needs rid={rid} pid={g.principal} />}
                </li>
              ))}
            </ul>
            <GrantForm kind={resource.kind} used={used} busy={grant.isPending} onGrant={(pid, relation) => grant.mutate({ pid, relation })} />
            {(grant.error ?? revoke.error) && <ErrorNote error={grant.error ?? revoke.error} prefix="Could not change access" />}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * What a person cannot open of what the resource uses, and the one step that opens it to them:
 * viewer on each the sharer may share; the rest is its owner's to share.
 */
function Needs({ rid, pid }: { rid: string; pid: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery(resourcesNeedsOptions({ path: { rid }, query: { principal: pid } }));
  const share = useMutation({
    mutationFn: (rids: string[]) => Promise.all(rids.map(r => unwrap(resourcesGrant({ path: { rid: r, pid }, body: { relation: "viewer" } })))),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesNeeds", path: { rid } }] }),
  });
  if (!data?.length) return null;
  const shareable = data.filter(n => n.shareable).map(n => n.resource.metadata.rid);
  const theirs = data.filter(n => !n.shareable).map(n => n.resource.metadata.name);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-needs={data.length}>
      <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      <span>
        Can't open {data.length === 1 ? "1 thing" : `${data.length} things`} this uses: {data.map(n => n.resource.metadata.name).join(" · ")}
      </span>
      {shareable.length > 0 && (
        <Button variant="outline" size="xs" onClick={() => share.mutate(shareable)} disabled={share.isPending} data-share-needs>
          {share.isPending && <Loader2 className="animate-spin" />} Share {shareable.length === data.length ? "them" : shareable.length} too
        </Button>
      )}
      {theirs.length > 0 && <span>Ask the owner to share {theirs.join(", ")}.</span>}
      {share.error && <ErrorNote error={share.error} prefix="Could not share" />}
    </div>
  );
}

function GrantForm({ kind, used, busy, onGrant }: { kind: string; used: boolean; busy: boolean; onGrant: (pid: string, relation: Relation) => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Principal>();
  const [relation, setRelation] = useState<Relation>(used ? "user" : "viewer");
  const q = useDeferredValue(query.trim());
  const { data } = useQuery({ ...principalsQuery(q), enabled: q.length > 0 && !picked });
  return (
    <div className="space-y-2" data-grant-form>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Input
            value={picked ? picked.displayName : query}
            placeholder="Find a person or group"
            aria-label="Principal"
            onChange={e => {
              setPicked(undefined);
              setQuery(e.target.value);
            }}
            className="h-8 text-xs"
          />
          {!picked && q && data && data.items.length > 0 && (
            <ul className="absolute top-full right-0 left-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg" role="listbox">
              {data.items.map(p => (
                <li key={p.pid}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => setPicked(p)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                    data-principal={p.displayName}>
                    <Avatar name={p.displayName} className="size-5 text-2xs" />
                    <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                    <span className="text-muted-foreground">{p.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <NativeSelect value={relation} onChange={e => setRelation(e.target.value as Relation)} aria-label="Relation">
          {RELATIONS.map(r => (
            <option key={r} value={r}>
              {relationLabel(kind, r)}
            </option>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          disabled={!picked || busy}
          onClick={() => {
            if (picked) onGrant(picked.pid, relation);
            setPicked(undefined);
            setQuery("");
          }}
          data-grant-button>
          {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Share
        </Button>
      </div>
    </div>
  );
}
