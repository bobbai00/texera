import { useQueryClient } from "@tanstack/react-query";
import { Button, DialogContent, DialogRoot, ErrorNote, Field, Input, Textarea } from "@texera/ui";
import { type FormEvent, useId, useState } from "react";
import { KINDS } from "../registry";
import type { KindId, ResourceRef } from "../types";
import { useOpenResource } from "./navigation";

/** Creates an empty resource of a kind, then opens it. Kinds without `create` do not offer it. */
export function NewResourceDialog({
  kind,
  open,
  onOpenChange,
  project,
}: {
  kind: KindId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: string;
}) {
  const spec = KINDS[kind];
  const queryClient = useQueryClient();
  const { expand } = useOpenResource();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const descriptionId = useId();
  if (!spec.create) return null;
  const create = spec.create;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const ref: ResourceRef = await create({ name: name.trim(), description: description.trim() || undefined, project });
      await queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      onOpenChange(false);
      setName("");
      setDescription("");
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
