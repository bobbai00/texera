import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DialogContent, DialogRoot, ErrorNote, Field, Input, Textarea } from "@texera/ui";
import { type FormEvent, useId, useState } from "react";
import { createResource } from "../api";
import { settingsQuery } from "../queries";
import { KINDS } from "../registry";
import type { KindId, ResourceRef } from "../types";
import { useOpenResource } from "./navigation";

/** Creates a resource of a kind with the kind's starting spec, then opens it. */
export function NewResourceDialog({
  kind,
  open,
  onOpenChange,
  parent,
}: {
  kind: KindId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parent?: string;
}) {
  const spec = KINDS[kind];
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery());
  const { expand } = useOpenResource();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const descriptionId = useId();
  if (!spec.defaultSpec) return null;
  const defaultSpec = spec.defaultSpec;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = { name: name.trim(), description: description.trim() || undefined, parent };
      const created = await createResource(kind, { ...input, spec: defaultSpec(input, settings?.spec.defaults ?? {}) });
      await queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      onOpenChange(false);
      setName("");
      setDescription("");
      const ref: ResourceRef = { kind, rid: created.metadata.rid, parent: created.metadata.parent };
      expand(ref);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`New ${spec.label.toLowerCase()}`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={`new-${kind}`} disabled={!name.trim() || busy}>
              Create
            </Button>
          </>
        }>
        <form id={`new-${kind}`} onSubmit={submit} className="space-y-3" data-new-resource={kind}>
          <Field label="Name" required htmlFor={nameId}>
            <Input id={nameId} value={name} onChange={e => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Description" htmlFor={descriptionId}>
            <Textarea id={descriptionId} value={description} onChange={e => setDescription(e.target.value)} rows={3} />
          </Field>
          {error !== undefined && <ErrorNote error={error} prefix="Could not create" />}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
