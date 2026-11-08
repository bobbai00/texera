// What a computing node is made of, as a profile says and as a unit has it: its size and the
// Python packages it adds to the platform's runtime. A unit is made from a profile version and
// may change since; these say how.

import type { ComputingNodeSpec, ComputingUnitSpec, ProfileSpec } from "@texera/catalog-client/types";

/** The sizes a node is offered in. A value none of them names is shown as it is. */
export const MEMORY_CHOICES = [
  { value: "2Gi", label: "2 GB" },
  { value: "4Gi", label: "4 GB" },
  { value: "8Gi", label: "8 GB" },
  { value: "16Gi", label: "16 GB" },
];
export const CPU_CHOICES = [
  { value: "", label: "Shared" },
  { value: "1", label: "1 core" },
  { value: "2", label: "2 cores" },
  { value: "4", label: "4 cores" },
  { value: "8", label: "8 cores" },
];
export const GPU_CHOICES = [
  { value: "", label: "None" },
  { value: "1", label: "1 GPU" },
  { value: "2", label: "2 GPUs" },
  { value: "4", label: "4 GPUs" },
];

/** What a node is made of: what a profile and a unit's node both say. */
export type Makeup = Pick<ProfileSpec, "cpu" | "memory" | "gpu" | "packages">;

/** The node a unit runs its engine on: the master, else the first. */
export const masterOf = (spec: Partial<ComputingUnitSpec>): ComputingNodeSpec | undefined =>
  spec.computingNodes?.find(n => n.role === "master") ?? spec.computingNodes?.[0];

/** The node's makeup, nothing else. */
export const makeupOf = (node: Makeup | undefined): Makeup => {
  const { cpu, memory, gpu, packages } = node ?? {};
  return {
    ...(cpu ? { cpu } : {}),
    ...(memory ? { memory } : {}),
    ...(gpu ? { gpu } : {}),
    ...(packages?.length ? { packages } : {}),
  };
};

/** The spec with its master node made of this: what the makeup leaves out, the node no longer says. */
export function withMakeup(spec: ComputingUnitSpec, makeup: Makeup): ComputingUnitSpec {
  const nodes = spec.computingNodes ?? [];
  const master = masterOf(spec) ?? { name: "master", role: "master" as const };
  const { cpu: _, memory: __, gpu: ___, packages: ____, ...rest } = master;
  const made: ComputingNodeSpec = { ...rest, ...makeupOf(makeup) };
  return {
    ...spec,
    computingNodes: nodes.includes(master) ? nodes.map(n => (n === master ? made : n)) : [...nodes, made],
  };
}

/** The spec of a unit made from a profile: its node names the profile and nothing else, so the catalog gives it the profile's makeup. */
export function madeFrom(spec: ComputingUnitSpec, profile: string | undefined): ComputingUnitSpec {
  const nodes = spec.computingNodes ?? [];
  const master = masterOf(spec);
  const made: ComputingNodeSpec = {
    name: master?.name ?? "master",
    role: master?.role ?? "master",
    ...(profile ? { profile } : { memory: "2Gi" }),
  };
  return { ...spec, computingNodes: master ? nodes.map(n => (n === master ? made : n)) : [...nodes, made] };
}

const nameIn = (requirement: string) => requirement.trim().split(/[<>=!~;[ @]/, 1)[0] ?? "";

/** The name a requirement installs, as pip compares names: `Scikit_Learn>=1` is `scikit-learn`. */
export const packageName = (requirement: string): string =>
  nameIn(requirement)
    .toLowerCase()
    .replace(/[-_.]+/g, "-");

/** A requirement as pip reads it: its name compared as pip does, no spaces. */
const canonical = (requirement: string) =>
  packageName(requirement) + requirement.trim().slice(nameIn(requirement).length).replace(/\s+/g, "");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A size in words, `4 GB · 2 cores · 1 GPU`; empty when the node reserves nothing of its own. */
export function sizeLabel(m: Makeup): string {
  const memory = m.memory ? (MEMORY_CHOICES.find(c => c.value === m.memory)?.label ?? m.memory) : "";
  const cpu = m.cpu ? (CPU_CHOICES.find(c => c.value === m.cpu)?.label ?? `${m.cpu} cores`) : "";
  const gpu = m.gpu ? plural(m.gpu, "GPU") : "";
  return [memory, cpu, gpu].filter(Boolean).join(" · ");
}

/** A makeup in words, for lists: its size and how many packages it adds. */
export const makeupFacts = (m: Makeup): string[] =>
  [sizeLabel(m), m.packages?.length ? plural(m.packages.length, "package") : ""].filter(Boolean);

/** What this deployment does with a profile, in words: why it cannot start a unit from it, or
 * that such a unit is the deployment's own, with the profile's packages but not its size. */
export const hereFacts = (status: { startable?: boolean; notHere?: string; sized?: boolean } | undefined): string[] =>
  status?.startable === false && status.notHere
    ? [`not here: ${status.notHere}`]
    : status?.sized === false
      ? ["on this deployment's own unit"]
      : [];

/** One way a node differs from its profile: a size, or a package added, removed or asked for otherwise. */
export interface Change {
  /** `memory`, `cpu`, `gpu`, or a package's name. */
  what: string;
  /** As the profile has it; absent when the profile has none. */
  was?: string;
  /** As the node has it; absent when the node has none. */
  now?: string;
}

/** How a node differs from the profile it was made from, size first, then package by package; empty when it is as the profile. */
export function changesFrom(profile: Makeup, node: Makeup): Change[] {
  const size = (["memory", "cpu", "gpu"] as const).flatMap(field => {
    const was = profile[field] ? String(profile[field]) : undefined;
    const now = node[field] ? String(node[field]) : undefined;
    return was === now ? [] : [{ what: field, ...(was ? { was } : {}), ...(now ? { now } : {}) }];
  });
  const byName = (packages: readonly string[] = []) => new Map(packages.map(p => [packageName(p), p.trim()]));
  const before = byName(profile.packages);
  const after = byName(node.packages);
  const packages = [...new Set([...before.keys(), ...after.keys()])].flatMap(name => {
    const was = before.get(name);
    const now = after.get(name);
    return was !== undefined && now !== undefined && canonical(was) === canonical(now)
      ? []
      : [{ what: name, ...(was ? { was } : {}), ...(now ? { now } : {}) }];
  });
  return [...size, ...packages];
}

/** A change in words: `+ humanize`, `− numpy`, `pandas → pandas==2.2.3`, `memory 2 GB → 4 GB`. */
export function changeLabel(c: Change): string {
  if (c.what === "memory" || c.what === "cpu" || c.what === "gpu") {
    const words = (v?: string) => (v ? sizeLabel({ [c.what]: c.what === "gpu" ? Number(v) : v }) : "none");
    return `${c.what === "cpu" ? "CPU" : c.what === "gpu" ? "GPU" : "memory"} ${words(c.was)} → ${words(c.now)}`;
  }
  if (!c.was) return `+ ${c.now}`;
  if (!c.now) return `− ${c.was}`;
  return `${c.was} → ${c.now}`;
}
