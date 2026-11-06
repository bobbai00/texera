import type { ProfileSpec } from "@texera/catalog-client/types";
import { Package } from "lucide-react";
import type { KindSpec } from "../types";
import { makeupFacts } from "./profiles";
import { SizeFields } from "./SizeFields";

/** A new profile's size, asked when it is made; its packages are added on its page. */
function NewProfile({ spec, onChange }: { spec: unknown; onChange: (spec: unknown) => void }) {
  const profile = spec as ProfileSpec;
  return (
    <SizeFields
      makeup={profile}
      onChange={size => onChange({ ...size, ...(profile.packages ? { packages: profile.packages } : {}) })}
    />
  );
}

/**
 * A profile: what a computing node is made of, its size and the Python packages it adds to the
 * platform's runtime. A unit is made from one; a unit is saved as one, its next version or a new
 * one. Its spec tab edits it, each save a version.
 */
export const profileKind: KindSpec = {
  kind: "profile",
  label: "Profile",
  plural: "Profiles",
  icon: Package,
  accent: "bg-kind-profile/12 text-kind-profile",
  defaultSpec: () => ({ memory: "2Gi" }) satisfies ProfileSpec,
  CreateFields: NewProfile,
  // The runtime release a profile was saved on is the platform's to say.
  hidden: ["runtime"],
  facts: r => makeupFacts(r.spec as ProfileSpec),
};
