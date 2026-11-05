// Who can do what with a resource: its visibility, and the grants by principal. The
// catalog answers through the authorizer; this only edits the grant tuples.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesGrant, resourcesRevoke } from "@texera/catalog-client";
import type { Principal, Relation, Resource } from "@texera/catalog-client/types";
import { Avatar, Badge, Button, EmptyState, ErrorNote, Input, NativeSelect, SectionTitle, Skeleton } from "@texera/ui";
import { Globe, Loader2, Lock, Trash2, UserPlus } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { CatalogError, unwrap, updateMetadata } from "../api";
import { grantsQuery, keysOf, principalsQuery } from "../queries";
import { kindEntry } from "../types";
import { PrincipalName } from "./Chips";

const RELATIONS: Relation[] = ["viewer", "editor", "owner", "user"];

export function Access({ resource, builtIn = false }: { resource: Resource; builtIn?: boolean }) {
  if (builtIn) {
    return (
      <div className="p-4" data-access="built-in">
        <SectionTitle>Access</SectionTitle>
        <p className="mt-2 text-sm text-muted-foreground">Built in: everyone can view and use it. It changes with a release of the platform, not from here.</p>
      </div>
    );
  }
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
  const unit = kindEntry(resource.kind).kind === "computing-unit";
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
                <li key={`${g.principal}:${g.relation}`} className="flex items-center gap-2 px-3 py-2 text-sm" data-grant={g.relation}>
                  <PrincipalName pid={g.principal} className="min-w-0 flex-1 truncate" />
                  <Badge>{g.relation}</Badge>
                  <Button variant="ghost" size="icon-xs" aria-label="Revoke" onClick={() => revoke.mutate(g.principal)} disabled={revoke.isPending}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <GrantForm unit={unit} busy={grant.isPending} onGrant={(pid, relation) => grant.mutate({ pid, relation })} />
            {(grant.error ?? revoke.error) && <ErrorNote error={grant.error ?? revoke.error} prefix="Could not change access" />}
          </>
        )}
      </section>
    </div>
  );
}

function GrantForm({ unit, busy, onGrant }: { unit: boolean; busy: boolean; onGrant: (pid: string, relation: Relation) => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Principal>();
  const [relation, setRelation] = useState<Relation>(unit ? "user" : "viewer");
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
              {r}
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
