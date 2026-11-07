import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { computingUnitsSaveAsProfile, computingUnitsTerminate } from "@texera/catalog-client";
import type { ComputingUnitSpec, ComputingUnitStatus, ProfileSpec, ProfileStatus, Resource } from "@texera/catalog-client/types";
import {
  Badge,
  Button,
  Chip,
  DataTable,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  NativeSelect,
  SectionTitle,
  Segmented,
} from "@texera/ui";
import { Check, Cpu, Loader2, Power, Save, Server } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { CatalogError, unwrap, updateSpec } from "../api";
import { canQuery, keysOf, readResource, resolveQuery, searchQuery } from "../queries";
import { useDestination, useScope } from "../scope";
import { useIsBuiltIn } from "../shell/builtin";
import { UriChip } from "../shell/Chips";
import type { KindSpec } from "../types";
import {
  changeLabel,
  changesFrom,
  type Makeup,
  madeFrom,
  makeupFacts,
  makeupOf,
  masterOf,
  packageName,
  sizeLabel,
  withMakeup,
} from "./profiles";
import { SizeFields } from "./SizeFields";

export const phaseTone = (phase: ComputingUnitStatus["phase"] | undefined) =>
  phase === "ready" ? "success" : phase === "failed" ? "danger" : phase === "pending" ? "warning" : "neutral";

/** The size of a makeup alone. */
const sizeOf = (m: Makeup | undefined): Makeup => {
  const { packages: _, ...size } = makeupOf(m);
  return size;
};

/** The unit's node (what it is made of), its endpoint and engine, and the nodes it reports. */
function Node({ resource }: { resource: Resource }) {
  const status = resource.status as ComputingUnitStatus | undefined;
  const spec = resource.spec as ComputingUnitSpec;
  return (
    <div className="scrollbar-thin flex-1 space-y-5 overflow-y-auto p-4" data-unit-nodes>
      {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
      {/* Another node from the catalog starts the form over; a change of status alone does not. */}
      <MadeOf key={JSON.stringify(spec.computingNodes ?? [])} resource={resource} />
      <section className="space-y-2">
        <SectionTitle>Endpoint</SectionTitle>
        <p className="text-sm">
          {spec.endpoint ? <code>{spec.endpoint}</code> : "Assigned by the unit provider."}
          {status?.engine?.version && (
            <span className="ml-2 text-muted-foreground">engine {status.engine.version}</span>
          )}
        </p>
      </section>
      <section className="space-y-2">
        <SectionTitle>Computing nodes</SectionTitle>
        {status?.computingNodes?.length ? (
          <DataTable
            columns={[{ name: "name" }, { name: "role" }, { name: "ready" }, { name: "message" }]}
            rows={status.computingNodes.map(n => [n.name, n.role, n.ready ? "yes" : "no", n.message ?? ""])}
            className="max-h-60 rounded-lg border"
          />
        ) : (
          <EmptyState className="py-4">No nodes reported.</EmptyState>
        )}
      </section>
    </div>
  );
}

/**
 * What the unit's node is made of: the profile version it was made from and how it differs
 * since, its size and its packages. Whoever may change the unit changes them here; a run
 * installs the packages. Saving it as a profile keeps what it is for others to make units from.
 */
function MadeOf({ resource }: { resource: Resource }) {
  const rid = resource.metadata.rid;
  const spec = resource.spec as ComputingUnitSpec;
  const status = resource.status as ComputingUnitStatus | undefined;
  const node = masterOf(spec);
  const saved = makeupOf(node);
  const [draft, setDraft] = useState<Makeup>(saved);
  const [adding, setAdding] = useState("");
  const queryClient = useQueryClient();
  const { data: mayChange } = useQuery(canQuery("write", rid));
  const { data: made } = useQuery({ ...resolveQuery(node?.profile ?? ""), enabled: !!node?.profile });
  const profile = made?.version?.content as ProfileSpec | undefined;
  const changes = profile ? changesFrom(profile, draft) : [];
  const dirty = JSON.stringify(makeupOf(draft)) !== JSON.stringify(saved);
  const save = useMutation({
    // The change goes onto the unit as it is now. Reading a unit probes it, so while it starts
    // anyone's read moves its status, and with it its etag, between this read and this write:
    // a write refused for that goes again on a fresh read, the makeup put on its spec anew.
    mutationFn: async () => {
      for (let attempt = 1; ; attempt++) {
        const now = await readResource(rid);
        try {
          return await updateSpec("computing-unit", rid, { spec: withMakeup(now.spec as ComputingUnitSpec, draft) }, now.metadata.etag);
        } catch (e) {
          if (!(e instanceof CatalogError && e.status === 412) || attempt >= 3) throw e;
        }
      }
    },
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const packages = draft.packages ?? [];
  const add = (e: FormEvent) => {
    e.preventDefault();
    const requirement = adding.trim();
    if (!requirement) return;
    // One requirement per package: one asked for again replaces the one there.
    const others = packages.filter(p => packageName(p) !== packageName(requirement));
    setDraft({ ...draft, packages: [...others, requirement] });
    setAdding("");
  };
  const remove = (requirement: string) => {
    const left = packages.filter(p => p !== requirement);
    const { packages: _, ...rest } = draft;
    setDraft(left.length ? { ...rest, packages: left } : rest);
  };
  const editable = !!mayChange;
  return (
    <section className="space-y-3" data-made-of>
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>Made of</SectionTitle>
        <span className="ml-auto">
          <SaveAsProfile resource={resource} made={made?.resource} disabled={dirty} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm" data-unit-profile>
        {node?.profile ? (
          <>
            <span className="text-muted-foreground">Made from</span>
            <UriChip uri={node.profile} emphasis />
            {profile &&
              (changes.length ? (
                <span className="flex flex-wrap items-center gap-1" data-unit-changes>
                  <span className="text-muted-foreground">and changed since:</span>
                  {changes.map(c => (
                    <Badge key={c.what} tone="warning">
                      {changeLabel(c)}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground" data-unit-changes="none">
                  as it is.
                </span>
              ))}
          </>
        ) : (
          <span className="text-muted-foreground">Made from no profile.</span>
        )}
      </div>
      <SizeFields
        makeup={sizeOf(draft)}
        onChange={size => setDraft({ ...size, ...(draft.packages ? { packages: draft.packages } : {}) })}
        disabled={!editable}
      />
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Python packages</p>
        <p className="text-sm text-muted-foreground">Added to the platform's runtime; the next run installs them.</p>
        <div className="flex flex-wrap items-center gap-1.5" data-unit-packages>
          {packages.map(p => (
            <Chip key={p} onRemove={editable ? () => remove(p) : undefined}>
              {p}
            </Chip>
          ))}
          {!packages.length && <span className="text-sm text-muted-foreground">None.</span>}
        </div>
        {editable && (
          <form onSubmit={add} className="flex max-w-md gap-2">
            <Input
              value={adding}
              onChange={e => setAdding(e.target.value)}
              placeholder="A package, e.g. humanize==4.11.0"
              aria-label="Package to add"
              data-add-package
            />
            <Button type="submit" variant="outline" size="sm" disabled={!adding.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
      {!!status?.installed?.length && (
        <p className="text-sm text-muted-foreground" data-unit-installed>
          Installed on its last run: {status.installed.join(", ")}
        </p>
      )}
      {save.error && <ErrorNote error={save.error} prefix="Could not change the unit" />}
      {editable && dirty && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-save-unit>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save changes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <span className="text-sm text-muted-foreground">A new size restarts the unit.</span>
        </div>
      )}
    </section>
  );
}

/**
 * Saves the unit as a profile: the next version of the profile it was made from, when the
 * caller may change that one, or a new profile. Its packages are saved as the unit installed
 * them; the unit is then made from what was saved.
 */
function SaveAsProfile({ resource, made, disabled }: { resource: Resource; made?: Resource; disabled?: boolean }) {
  const rid = resource.metadata.rid;
  const queryClient = useQueryClient();
  const builtIn = useIsBuiltIn();
  const { data: mayUpdate } = useQuery({ ...canQuery("write", made?.metadata.rid ?? ""), enabled: !!made });
  const updatable = !!made && !!mayUpdate && !builtIn(made);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"update" | "new">("update");
  const [name, setName] = useState("");
  const nameId = useId();
  const choice = updatable ? mode : "new";
  // A new profile goes into the unit's project; a built-in unit's, into the one the person works in.
  const { project: working, label } = useDestination();
  const into = builtIn(resource) ? working : undefined;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        computingUnitsSaveAsProfile({
          path: { rid },
          body:
            choice === "update" && made
              ? { profile: made.metadata.uri }
              : { name: name.trim(), ...(into ? { parent: into } : {}) },
        })
      ),
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      queryClient.invalidateQueries({ queryKey: ["resolve"] });
      setOpen(false);
      setName("");
    },
  });
  const ready = choice === "update" || name.trim() !== "";
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? "Save the unit's changes first" : undefined}
        data-save-as-profile>
        <Save /> Save as profile
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Save ${resource.metadata.name} as a profile`}
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" form={`save-profile-${rid}`} disabled={!ready || save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
            </>
          }>
          <form
            id={`save-profile-${rid}`}
            className="space-y-3"
            onSubmit={e => {
              e.preventDefault();
              if (ready) save.mutate();
            }}
            data-save-profile-form>
            <p className="text-sm text-muted-foreground">
              The profile gets this unit's size and packages, each package at the version the unit installed. The unit
              is then made from it.
            </p>
            {updatable && made && (
              <Segmented
                label="Save as"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "update", label: `Next version of ${made.metadata.name}` },
                  { value: "new", label: "A new profile" },
                ]}
              />
            )}
            {choice === "new" && (
              <Field
                label="Name"
                required
                htmlFor={nameId}
                help={`It goes into ${builtIn(resource) ? (label ?? "your own project") : "the unit's project"}.`}>
                <Input id={nameId} value={name} onChange={e => setName(e.target.value)} autoFocus data-profile-name />
              </Field>
            )}
            {save.error && <ErrorNote error={save.error} prefix="Could not save the profile" />}
          </form>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

function Actions({ resource, readonly }: { resource: Resource; readonly?: boolean }) {
  const queryClient = useQueryClient();
  const status = resource.status as ComputingUnitStatus | undefined;
  const terminate = useMutation({
    mutationFn: () => unwrap(computingUnitsTerminate({ path: { rid: resource.metadata.rid } })),
    onSuccess: () => {
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <>
      {status && <Badge tone={phaseTone(status.phase)}>{status.phase}</Badge>}
      {!readonly && status?.phase !== "terminated" && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => confirm("Terminate this unit?") && terminate.mutate()}
          disabled={terminate.isPending}>
          {terminate.isPending ? <Loader2 className="animate-spin" /> : <Power />} Terminate
        </Button>
      )}
    </>
  );
}

/**
 * What a new unit is made from: a profile, whose size can be changed here; its packages come
 * with it and are changed on the unit's page.
 */
function NewUnit({ spec, onChange }: { spec: unknown; onChange: (spec: unknown) => void }) {
  const unit = spec as ComputingUnitSpec;
  const node = masterOf(unit);
  const { data: profiles } = useQuery(searchQuery({ kind: "profile", scope: useScope() }));
  const id = useId();
  const chosen = profiles?.items.find(p => p.metadata.uri === node?.profile);
  // The size the unit gets: its own where it says one, the profile's otherwise.
  const size = { ...sizeOf(chosen?.spec as ProfileSpec | undefined), ...sizeOf(node) };
  return (
    <div className="space-y-3" data-new-unit>
      <Field label="Profile" htmlFor={id} help="What the unit is made of: its size and the Python packages it adds.">
        <NativeSelect
          id={id}
          value={node?.profile ?? ""}
          onChange={e => onChange(madeFrom(unit, e.target.value || undefined))}
          className="w-full"
          data-field="profile">
          {profiles?.items.map(p => {
            // A profile this deployment cannot start says why beside its name.
            const status = p.status as ProfileStatus | undefined;
            const notHere = status?.startable === false && status.notHere ? [`not here: ${status.notHere}`] : [];
            return (
              <option key={p.metadata.uri} value={p.metadata.uri} data-startable={status?.startable !== false}>
                {[p.metadata.name, ...makeupFacts(p.spec as ProfileSpec), ...notHere].join(" · ")}
              </option>
            );
          })}
          <option value="">No profile</option>
        </NativeSelect>
      </Field>
      <SizeFields
        makeup={size}
        onChange={changed =>
          onChange(withMakeup(unit, { ...changed, ...(node?.packages ? { packages: node.packages } : {}) }))
        }
      />
    </div>
  );
}

export const computingUnitKind: KindSpec = {
  kind: "computing-unit",
  label: "Computing unit",
  plural: "Computing units",
  icon: Cpu,
  accent: "bg-kind-computing-unit/12 text-kind-computing-unit",
  tabs: [{ value: "node", label: "Node", icon: Server, Component: Node }],
  Actions,
  // A new unit is one the platform runs (on Kubernetes, a Deployment the catalog reconciles),
  // made from the platform's default profile.
  defaultSpec: (_, defaults) => madeFrom({ provider: "kubernetes" }, defaults.profile),
  CreateFields: NewUnit,
  facts: r => {
    const spec = r.spec as Partial<ComputingUnitSpec>;
    const status = r.status as Partial<ComputingUnitStatus> | undefined;
    return [spec.provider ?? "", status?.phase ?? "", sizeLabel(makeupOf(masterOf(spec)))].filter(Boolean);
  },
};
