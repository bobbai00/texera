// The spec tab of the generic page: the kind's schema as a form, or the JSON itself, saved
// as a new version (versioned kinds) or in place, with the head and etag the editor saw.
//
// The editor keeps a draft against the resource it started from. A change to the resource
// that is not its spec (a rename, its visibility) leaves the draft as it is and is taken in,
// so the next save carries the new etag. A change to its spec while nothing is edited is
// shown at once; while something is, the person is told, and keeps their draft or takes the
// other's. A save refused because the resource moved says the same, never a dead end.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button, ErrorNote, Textarea, cn } from "@texera/ui";
import { Braces, Check, ListTree, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CatalogError, canUpdate, updateSpec } from "../api";
import { keysOf, readResource } from "../queries";
import { KINDS } from "../registry";
import { prune, specSchema } from "../schema/schema";
import { SchemaForm } from "../schema/SchemaForm";
import { kindEntry } from "../types";

export function SpecEditor({ resource, readonly = false }: { resource: Resource; readonly?: boolean }) {
  const kind = resource.kind;
  const spec = KINDS[kind];
  const schema = specSchema(kind);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, unknown>>(() => structuredClone(resource.spec));
  // The resource the draft was started from, or rebased onto: its spec, head and etag go with a save.
  const [base, setBase] = useState(() => ({ spec: resource.spec, head: resource.metadata.head, etag: resource.metadata.etag }));
  // Someone else's spec, saved while this person had edits of their own.
  const [theirs, setTheirs] = useState<Resource>();
  const [json, setJson] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(resource.spec, null, 2));
  const [parseError, setParseError] = useState<string>();
  const versioned = kindEntry(kind).versioned;
  const shape = (spec: Record<string, unknown>) => JSON.stringify(schema ? prune(spec, schema) : spec);
  const dirty = shape(draft) !== shape(base.spec);
  const startFrom = (r: Resource) => {
    setBase({ spec: r.spec, head: r.metadata.head, etag: r.metadata.etag });
    setDraft(structuredClone(r.spec));
    setText(JSON.stringify(r.spec, null, 2));
    setParseError(undefined);
    setTheirs(undefined);
  };
  // The resource as the catalog has it now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each new answer of the catalog
  useEffect(() => {
    if (shape(resource.spec) === shape(base.spec)) {
      if (resource.metadata.etag !== base.etag) setBase(b => ({ ...b, head: resource.metadata.head, etag: resource.metadata.etag }));
      return;
    }
    if (!dirty) startFrom(resource);
    else setTheirs(resource);
  }, [resource]);
  const save = useMutation({
    mutationFn: async () => {
      const body = schema ? prune(draft, schema) : draft;
      const write = (head: number, etag: string) =>
        updateSpec(kind, resource.metadata.rid, { spec: body, ...(versioned ? { expectedHead: head, message: "Edited in the app" } : {}) }, etag);
      try {
        return await write(base.head, base.etag);
      } catch (e) {
        // Refused because the resource moved: if only what is not its spec moved (a unit's
        // status, a rename), the save goes again as it was meant; a spec someone else changed
        // is the person's to decide (below).
        if (!(e instanceof CatalogError && e.status === 412)) throw e;
        const now = await readResource(resource.metadata.rid);
        if (shape(now.spec) !== shape(base.spec)) throw e;
        return await write(now.metadata.head, now.metadata.etag);
      }
    },
    onSuccess: saved => {
      // What was saved is the base from now on: the draft is no longer an edit, and the
      // catalog's next answer is this person's own save, not someone else's.
      setBase({ spec: saved.spec, head: saved.metadata.head, etag: saved.metadata.etag });
      setDraft(structuredClone(saved.spec));
      setText(JSON.stringify(saved.spec, null, 2));
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resolve" }] });
    },
    onError: error => {
      // It moved under the edit: ask the catalog again, and the answer is offered above.
      if (error instanceof CatalogError && (error.status === 409 || error.status === 412))
        for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const moved = save.error instanceof CatalogError && (save.error.status === 409 || save.error.status === 412);
  const editable = !readonly && canUpdate(kind);
  const switchTo = (toJson: boolean) => {
    if (toJson) setText(JSON.stringify(draft, null, 2));
    setJson(toJson);
  };
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={e => {
        e.preventDefault();
        if (dirty && !parseError) save.mutate();
      }}
      data-spec-editor={kind}>
      <div className="flex items-center gap-1">
        <Button type="button" variant={json ? "ghost" : "secondary"} size="xs" onClick={() => switchTo(false)} disabled={!schema}>
          <ListTree /> Form
        </Button>
        <Button type="button" variant={json ? "secondary" : "ghost"} size="xs" onClick={() => switchTo(true)}>
          <Braces /> JSON
        </Button>
      </div>
      {json || !schema ? (
        <Textarea
          value={text}
          rows={18}
          spellCheck={false}
          disabled={!editable}
          className={cn("font-mono text-xs", parseError && "border-destructive")}
          onChange={e => {
            setText(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value);
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the spec must be a JSON object");
              setDraft(parsed);
              setParseError(undefined);
            } catch (err) {
              setParseError(err instanceof Error ? err.message : String(err));
            }
          }}
          data-spec-json
        />
      ) : (
        <SchemaForm schema={schema} value={draft} onChange={setDraft} long={spec.long} hidden={spec.hidden} disabled={!editable} />
      )}
      {parseError && <p className="text-xs text-destructive">{parseError}</p>}
      {theirs && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-spec-changed>
          <span>Someone saved a change to this {spec.label.toLowerCase()} while you were editing it.</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              // Their version becomes the base; this person's draft stays, to be saved over it.
              setBase({ spec: theirs.spec, head: theirs.metadata.head, etag: theirs.metadata.etag });
              setTheirs(undefined);
              save.reset();
            }}
            data-keep-mine>
            Keep mine
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              startFrom(theirs);
              save.reset();
            }}
            data-take-theirs>
            Take theirs
          </Button>
        </div>
      )}
      {save.error && !(moved && theirs) && (
        <ErrorNote error={save.error} prefix={moved ? "Not saved: it changed since you opened it. Press Save again to save over it" : "Could not save"} />
      )}
      {editable && (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!dirty || !!parseError || save.isPending} data-save-spec>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} {versioned ? "Save as new version" : "Save"}
          </Button>
          {!dirty && <span className="text-xs text-muted-foreground">No changes.</span>}
        </div>
      )}
    </form>
  );
}
