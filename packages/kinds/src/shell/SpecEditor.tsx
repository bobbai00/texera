// The spec tab of the generic page: the kind's schema as a form, or the JSON itself, saved
// as a new version (versioned kinds) or in place, with the head and etag the editor saw.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button, ErrorNote, Textarea, cn } from "@texera/ui";
import { Braces, Check, ListTree, Loader2 } from "lucide-react";
import { useState } from "react";
import { canUpdate, updateSpec } from "../api";
import { keysOf } from "../queries";
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
  const [json, setJson] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(resource.spec, null, 2));
  const [parseError, setParseError] = useState<string>();
  const versioned = kindEntry(kind).versioned;
  const save = useMutation({
    mutationFn: () => {
      const body = schema ? prune(draft, schema) : draft;
      return updateSpec(kind, resource.metadata.rid, { spec: body, ...(versioned ? { expectedHead: resource.metadata.head, message: "Edited in the app" } : {}) }, resource.metadata.etag);
    },
    onSuccess: () => {
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resolve" }] });
    },
  });
  const dirty = JSON.stringify(schema ? prune(draft, schema) : draft) !== JSON.stringify(schema ? prune(resource.spec, schema) : resource.spec);
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
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
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
