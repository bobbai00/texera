import type { Resource } from "@texera/catalog-client/types";

/** What a resource is, in words: its own description, or for a custom operator the one its code gives. */
export function describe(r: Resource): string {
  return r.metadata.description || (r.spec as { description?: string } | undefined)?.description || "";
}

/** A project's operators and those it inherits, the operators built into the engine among them. */
export function operatorsOf(resources: Resource[], project?: string): { own: Resource[]; builtIn: Resource[] } {
  const own = resources.filter(r => r.metadata.project === project);
  return { own, builtIn: resources.filter(r => r.metadata.project !== project) };
}
