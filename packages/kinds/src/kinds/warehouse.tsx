import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSpec, Resource, WarehouseSpec, WarehouseStatus, WarehouseStorage } from "@texera/catalog-client/types";
import { Badge, Button, ErrorNote, Field, Input, NativeSelect, SectionTitle } from "@texera/ui";
import { Check, Loader2, Warehouse } from "lucide-react";
import { Fragment, type ReactNode, useId } from "react";
import { updateSpec } from "../api";
import { canQuery, keysOf, resourceQuery } from "../queries";
import { useIsBuiltIn } from "../shell/builtin";
import { UriChip } from "../shell/Chips";
import type { KindSpec } from "../types";
import { CredentialPicker } from "../workflow/CredentialPicker";

/** Where a warehouse keeps its tables, in a few words. */
export function placeOf(spec: Partial<WarehouseSpec>): string {
  const storage = spec.storage;
  if (!storage) return "on the platform's store";
  return `${storage.bucket}${storage.keyPrefix ? `/${storage.keyPrefix.replace(/^\/+|\/+$/g, "")}` : ""} on ${storage.endpoint.replace(/^https?:\/\//, "")}`;
}

/**
 * Whether the warehouse's own project keeps its results here, and the one click that makes it
 * so: an execution keeps its results in the warehouse its project names, unless the workflow
 * or the run names another.
 */
function Actions({ resource, readonly }: { resource: Resource; readonly?: boolean }) {
  const queryClient = useQueryClient();
  const builtIn = useIsBuiltIn()(resource);
  const project = resource.metadata.project;
  const { data: owner } = useQuery({ ...resourceQuery(project), enabled: !builtIn });
  const { data: mayChange } = useQuery({ ...canQuery("write", project), enabled: !builtIn });
  const spec = (owner?.spec ?? {}) as ProjectSpec;
  const used = spec.defaultWarehouse === resource.metadata.uri;
  const choose = useMutation({
    mutationFn: (on: boolean) => {
      const { defaultWarehouse: _, ...rest } = spec;
      return updateSpec("project", project, { spec: on ? { ...rest, defaultWarehouse: resource.metadata.uri } : rest });
    },
    onSuccess: () => {
      for (const key of keysOf(project)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  if (builtIn) return <Badge data-warehouse-default="platform">Where results go unless a project names another</Badge>;
  if (!owner) return null;
  return (
    <>
      {choose.error && <ErrorNote error={choose.error} prefix="Could not change the project" />}
      {used ? (
        <Badge tone="success" data-warehouse-default="project">
          <Check className="size-3" /> {owner.metadata.name} keeps its results here
        </Badge>
      ) : null}
      {mayChange && !readonly && (
        <Button variant="outline" size="sm" onClick={() => choose.mutate(!used)} disabled={choose.isPending} data-warehouse-use={used ? "stop" : "start"}>
          {choose.isPending ? <Loader2 className="animate-spin" /> : null} {used ? "Stop keeping results here" : `Keep ${owner.metadata.name}'s results here`}
        </Button>
      )}
    </>
  );
}

/** Where a warehouse keeps its tables, on its page. Nothing here changes: a warehouse does not move. */
function Place({ resource }: { resource: Resource }) {
  const storage = (resource.spec as WarehouseSpec).storage;
  const name = (resource.status as WarehouseStatus | undefined)?.name;
  const rows: [string, ReactNode][] = storage
    ? [
        ["Store", storage.endpoint],
        ["Bucket", storage.bucket],
        ["Folder", storage.keyPrefix || "the whole bucket"],
        ["Region", storage.region],
        ["Credential", <UriChip key="credential" uri={storage.credential} />],
      ]
    : [["Store", "The platform's own"]];
  if (name) rows.push(["Name in the lake", <code key="name">{name}</code>]);
  return (
    <section className="space-y-2 p-4" data-warehouse-place>
      <SectionTitle>Where it keeps its tables</SectionTitle>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

/** A store of one's own before anything is typed. */
const OWN_STORE: WarehouseStorage = { endpoint: "", region: "us-east-1", bucket: "", credential: "" };

/**
 * Where a new warehouse keeps its tables: asked when it is made, since a warehouse does not
 * move. The platform's store needs nothing; a store of one's own needs its address, the
 * bucket and the credential that holds its key.
 */
function ChoosePlace({ spec, onChange }: { spec: unknown; onChange: (spec: unknown) => void }) {
  const storage = (spec as WarehouseSpec).storage;
  const ids = { where: useId(), endpoint: useId(), region: useId(), bucket: useId(), keyPrefix: useId(), credential: useId() };
  const set = (patch: Partial<WarehouseStorage>) => {
    const { keyPrefix, ...rest } = { ...OWN_STORE, ...storage, ...patch };
    onChange({ storage: keyPrefix ? { ...rest, keyPrefix } : rest } satisfies WarehouseSpec);
  };
  return (
    <div className="space-y-3" data-warehouse-choose-place>
      <Field label="Where it keeps its tables" htmlFor={ids.where} help="A warehouse does not move: this is chosen once.">
        <NativeSelect id={ids.where} value={storage ? "own" : "platform"} onChange={e => onChange(e.target.value === "own" ? { storage: OWN_STORE } : {})} className="w-full" data-field="where">
          <option value="platform">On the platform's store</option>
          <option value="own">On a store of your own</option>
        </NativeSelect>
      </Field>
      {storage && (
        <>
          <Field label="Endpoint" required htmlFor={ids.endpoint} help="The S3 address of the store. An administrator lists the stores a warehouse may be on.">
            <Input id={ids.endpoint} value={storage.endpoint} placeholder="https://store.example.org" onChange={e => set({ endpoint: e.target.value.trim() })} data-field="endpoint" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bucket" required htmlFor={ids.bucket}>
              <Input id={ids.bucket} value={storage.bucket} onChange={e => set({ bucket: e.target.value.trim() })} data-field="bucket" />
            </Field>
            <Field label="Region" required htmlFor={ids.region}>
              <Input id={ids.region} value={storage.region} onChange={e => set({ region: e.target.value.trim() })} data-field="region" />
            </Field>
          </div>
          <Field label="Folder" htmlFor={ids.keyPrefix} help="A path in the bucket that only this warehouse uses; the whole bucket when empty.">
            <Input id={ids.keyPrefix} value={storage.keyPrefix ?? ""} onChange={e => set({ keyPrefix: e.target.value.trim() })} data-field="keyPrefix" />
          </Field>
          <Field label="Credential" required htmlFor={ids.credential} help="Its secret holds accessKeyId and secretAccessKey.">
            <CredentialPicker id={ids.credential} value={storage.credential} onChange={credential => set({ credential })} disabled={false} />
          </Field>
        </>
      )}
    </div>
  );
}

export const warehouseKind: KindSpec = {
  kind: "warehouse",
  label: "Warehouse",
  plural: "Warehouses",
  icon: Warehouse,
  accent: "bg-kind-warehouse/12 text-kind-warehouse",
  // With no store of its own, a warehouse gets a place on the platform's.
  defaultSpec: () => ({}) satisfies WarehouseSpec,
  CreateFields: ChoosePlace,
  Editor: Place,
  Actions,
  facts: r => {
    const name = (r.status as WarehouseStatus | undefined)?.name;
    return [placeOf(r.spec as Partial<WarehouseSpec>), name ? `named ${name} in the lake` : ""].filter(Boolean);
  },
};
