// A credential's page: its kind and scope come from the schema form; the secret itself is
// written here and never read back.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { credentialsSetSecret } from "@texera/catalog-client";
import type { CredentialSpec, CredentialStatus, Resource } from "@texera/catalog-client/types";
import { Badge, Button, ErrorNote, Field, Input, timeAgo } from "@texera/ui";
import { Check, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { unwrap } from "../api";
import { keysOf } from "../queries";
import { KeyValueList } from "../schema/SchemaForm";
import type { KindSpec } from "../types";

/** The fields a secret of each kind holds. */
const FIELDS: Partial<Record<CredentialSpec["kind"], string[]>> = {
  api_key: ["value"],
  bearer_token: ["token"],
  basic: ["username", "password"],
  oauth_client: ["clientId", "clientSecret"],
};

function Secret({ resource }: { resource: Resource }) {
  const kind = (resource.spec as CredentialSpec).kind;
  const status = resource.status as CredentialStatus | undefined;
  const named = FIELDS[kind];
  const [fields, setFields] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();
  const ids = useId();
  const save = useMutation({
    mutationFn: () => unwrap(credentialsSetSecret({ path: { rid: resource.metadata.rid }, body: { fields } })),
    onSuccess: () => {
      setFields({});
      for (const key of keysOf(resource.metadata.rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const complete = named ? named.every(f => fields[f]?.length) : Object.keys(fields).length > 0;
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={e => {
        e.preventDefault();
        if (complete) save.mutate();
      }}
      data-secret-form>
      <div className="flex items-center gap-2 text-sm">
        {status?.hasSecret ? (
          <Badge tone="success">
            <ShieldCheck className="size-3" /> secret set{status.rotatedAt ? ` · ${timeAgo(status.rotatedAt)}` : ""}
          </Badge>
        ) : (
          <Badge tone="warning">no secret yet</Badge>
        )}
        <span className="text-xs text-muted-foreground">The value lives in the secret store; it is written here and never shown again.</span>
      </div>
      {named ? (
        named.map(f => (
          <Field key={f} label={f} required htmlFor={`${ids}-${f}`}>
            <Input
              id={`${ids}-${f}`}
              type={/secret|password|token|value/i.test(f) ? "password" : "text"}
              autoComplete="off"
              value={fields[f] ?? ""}
              onChange={e => setFields({ ...fields, [f]: e.target.value })}
              data-secret-field={f}
            />
          </Field>
        ))
      ) : (
        <Field label="Fields" help="The secret's fields, by name.">
          <KeyValueList value={fields} onChange={setFields} name="fields" />
        </Field>
      )}
      {save.error && <ErrorNote error={save.error} prefix="Could not write the secret" />}
      <Button type="submit" disabled={!complete || save.isPending} data-save-secret>
        {save.isPending ? <Loader2 className="animate-spin" /> : save.isSuccess ? <Check /> : <KeyRound />} {status?.hasSecret ? "Replace secret" : "Set secret"}
      </Button>
    </form>
  );
}

export const credentialKind: KindSpec = {
  kind: "credential",
  label: "Credential",
  plural: "Credentials",
  icon: KeyRound,
  accent: "bg-kind-credential/12 text-kind-credential",
  tabs: [{ value: "secret", label: "Secret", icon: ShieldCheck, Component: Secret }],
  defaultSpec: () => ({ kind: "api_key" }) satisfies CredentialSpec,
  facts: r => {
    const spec = r.spec as Partial<CredentialSpec>;
    const status = r.status as CredentialStatus | undefined;
    return [spec.kind ?? "", status?.hasSecret ? "secret set" : "no secret"].filter(Boolean);
  },
};
