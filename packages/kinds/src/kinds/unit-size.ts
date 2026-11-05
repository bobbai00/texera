// The size of a computing unit: the memory and CPU its master node reserves on the cluster.
// The catalog runs a unit as one pod, sized by that node.

import type { ComputingNodeSpec, ComputingUnitSpec } from "@texera/catalog-client/types";

export interface UnitSize {
  /** A Kubernetes quantity, e.g. `4Gi`; empty reserves the deployment's default. */
  memory: string;
  /** Cores, e.g. `2`; empty reserves none. */
  cpu: string;
}

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

const isMaster = (node: ComputingNodeSpec) => node.role === "master";

export function sizeOf(spec: ComputingUnitSpec): UnitSize {
  const master = spec.computingNodes?.find(isMaster);
  return { memory: master?.memory ?? "", cpu: master?.cpu ?? "" };
}

/** The spec with its master node reserving the given size; what is left empty reserves nothing. */
export function sized(spec: ComputingUnitSpec, size: Partial<UnitSize>): ComputingUnitSpec {
  const nodes = spec.computingNodes ?? [];
  const { memory: _, cpu: __, ...master } = nodes.find(isMaster) ?? { name: "master", role: "master" as const };
  const { memory, cpu } = { ...sizeOf(spec), ...size };
  const resized: ComputingNodeSpec = { ...master, ...(memory ? { memory } : {}), ...(cpu ? { cpu } : {}) };
  return { ...spec, computingNodes: nodes.some(isMaster) ? nodes.map(n => (isMaster(n) ? resized : n)) : [...nodes, resized] };
}
