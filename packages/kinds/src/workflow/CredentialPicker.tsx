import { useQuery } from "@tanstack/react-query";
import type { CredentialSpec, CredentialStatus } from "@texera/catalog-client/types";
import { NativeSelect } from "@texera/ui";
import { searchQuery } from "../queries";

/**
 * A property that takes a credential: the person picks one of theirs and the spec holds its
 * URI (`texera://credentials/{rid}`); the catalog leases the secret for each run and puts it
 * in the plan, so no version ever holds a value.
 */
export function CredentialPicker({ id, value, onChange, disabled }: { id: string; value: string; onChange: (uri: string) => void; disabled: boolean }) {
  const { data } = useQuery(searchQuery({ kind: "credential" }));
  const items = data?.items ?? [];
  const known = items.some(c => c.metadata.uri === value);
  return (
    <NativeSelect id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} className="w-full" data-credential-picker>
      <option value="">No credential</option>
      {items.map(c => {
        const spec = c.spec as Partial<CredentialSpec>;
        const status = c.status as CredentialStatus | undefined;
        return (
          <option key={c.metadata.rid} value={c.metadata.uri}>
            {c.metadata.name}
            {spec.kind ? ` (${spec.kind})` : ""}
            {status?.hasSecret ? "" : " — no secret yet"}
          </option>
        );
      })}
      {value && !known && <option value={value}>{value}</option>}
    </NativeSelect>
  );
}
