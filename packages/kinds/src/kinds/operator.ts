import type { OperatorSpec } from "@texera/catalog-client/types";
import { Blocks } from "lucide-react";
import type { KindSpec } from "../types";

const STARTER = `from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        yield tuple_
`;

export const operatorKind: KindSpec = {
  kind: "operator",
  label: "Operator",
  plural: "Operators",
  icon: Blocks,
  accent: "bg-kind-operator/12 text-kind-operator",
  long: ["code", "description"],
  /** A custom Python operator: one input, one output, the engine's UDF interface. */
  defaultSpec: ({ name, description }) =>
    ({
      operatorType: name.replace(/[^A-Za-z0-9]+/g, ""),
      displayName: name,
      group: "Custom",
      ...(description ? { description } : {}),
      inputPorts: [{ portID: "input-0" }],
      outputPorts: [{ portID: "output-0" }],
      implementation: { python: { code: STARTER } },
    }) satisfies OperatorSpec,
  facts: r => {
    const spec = r.spec as Partial<OperatorSpec>;
    return [spec.implementation ? "custom" : "engine", spec.group ?? ""].filter(Boolean);
  },
};
