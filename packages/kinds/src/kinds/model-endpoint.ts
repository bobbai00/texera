import type { ModelEndpointSpec } from "@texera/catalog-client/types";
import { BrainCircuit } from "lucide-react";
import type { KindSpec } from "../types";

export const modelEndpointKind: KindSpec = {
  kind: "model-endpoint",
  label: "Model endpoint",
  plural: "Model endpoints",
  icon: BrainCircuit,
  accent: "bg-kind-model-endpoint/12 text-kind-model-endpoint",
  defaultSpec: () => ({ provider: "anthropic", model: "claude-haiku-5-5" }) satisfies ModelEndpointSpec,
  facts: r => {
    const spec = r.spec as Partial<ModelEndpointSpec>;
    return [spec.provider ?? "", spec.model ?? ""].filter(Boolean);
  },
};
