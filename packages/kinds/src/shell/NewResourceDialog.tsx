import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DialogContent, DialogRoot, ErrorNote, Field, Input, NativeSelect, Select, Textarea } from "@texera/ui";
import { type FormEvent, useId, useState } from "react";
import { createResource } from "../api";
import { meQuery, projectSettingsQuery } from "../queries";
import { KINDS } from "../registry";
import { projectsQuery, useDestination, useWorkingProject } from "../scope";
import type { KindId, ResourceRef } from "../types";
import { useOpenResource } from "./navigation";

/**
 * Creates a resource of a kind, then opens it. It goes into the project the person works in,
 * which the dialog names; with every project in view the dialog asks which. A new project is
 * the one the person works in from then on, and inherits from Texera unless the person picks one
 * of their own. The spec is the kind's starting one, from the defaults of the project it goes
 * into, as the kind's own fields changed it when it has some.
 */
export function NewResourceDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: KindId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const spec = KINDS[kind];
  const queryClient = useQueryClient();
  const { expand } = useOpenResource();
  const { pick } = useWorkingProject();
  // A project is in no project: it inherits from one.
  const within = kind !== "project";
  const { project, label, asking, projects, choose } = useDestination();
  const parent = within ? project : undefined;
  const { data: settings } = useQuery({ ...projectSettingsQuery(parent ?? ""), enabled: !!parent });
  const { data: me } = useQuery(meQuery());
  const { data: readable } = useQuery({ ...projectsQuery(), enabled: !within });
  const [base, setBase] = useState<string>();
  const baseId = useId();
  // A new project inherits from Texera or from a project of the person's own.
  const bases = (readable?.items ?? []).filter(p => p.metadata.rid === me?.rootProject || p.metadata.owner === me?.principal.pid);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  // The spec as the kind's own fields made it; undefined until one is changed.
  const [chosen, setChosen] = useState<unknown>();
  const nameId = useId();
  const descriptionId = useId();
  const projectId = useId();
  if (!spec.defaultSpec) return null;
  const defaultSpec = spec.defaultSpec;
  const CreateFields = spec.CreateFields;
  const starting = (input: { name: string; description?: string; parent?: string }) => chosen ?? defaultSpec(input, settings?.defaults ?? {});

  const ready = name.trim() !== "" && (!within || parent !== undefined);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = { name: name.trim(), description: description.trim() || undefined, parent };
      const created = await createResource(kind, { ...input, ...(!within && base ? { base } : {}), spec: starting(input) });
      await queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      // A project is made to work in.
      if (kind === "project") await pick(created.metadata.rid);
      onOpenChange(false);
      setName("");
      setDescription("");
      setChosen(undefined);
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
        title={
          within && !asking && label ? `New ${spec.label.toLowerCase()} in ${label}` : `New ${spec.label.toLowerCase()}`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={`new-${kind}`} disabled={!ready || busy}>
              Create
            </Button>
          </>
        }>
        <form
          id={`new-${kind}`}
          onSubmit={submit}
          className="space-y-3"
          data-new-resource={kind}
          data-new-in={parent ?? ""}>
          <Field label="Name" required htmlFor={nameId}>
            <Input id={nameId} value={name} onChange={e => setName(e.target.value)} autoFocus />
          </Field>
          {within && asking && (
            <Field
              label="Project"
              required
              htmlFor={projectId}
              help="Every project is in view, so say which one this goes into.">
              <Select
                id={projectId}
                aria-label="Project to make it in"
                value={project ?? null}
                onChange={choose}
                options={projects}
                placeholder="Choose a project"
                className="w-full"
              />
            </Field>
          )}
          {!within && bases.length > 1 && (
            <Field label="Inherits from" htmlFor={baseId} help="Its people read and use what that project holds, and its settings fill in what this one's leave out.">
              <NativeSelect id={baseId} value={base ?? me?.rootProject ?? ""} onChange={e => setBase(e.target.value)} data-new-base>
                {bases.map(p => (
                  <option key={p.metadata.rid} value={p.metadata.rid}>
                    {p.metadata.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Description" htmlFor={descriptionId}>
            <Textarea id={descriptionId} value={description} onChange={e => setDescription(e.target.value)} rows={3} />
          </Field>
          {CreateFields && <CreateFields spec={starting({ name, description, parent })} onChange={setChosen} />}
          {error !== undefined && <ErrorNote error={error} prefix="Could not create" />}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
