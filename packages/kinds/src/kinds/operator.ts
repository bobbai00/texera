import type { OperatorSpec } from "@texera/catalog-client/types";
import { Blocks } from "lucide-react";
import type { KindSpec } from "../types";

/** The Python name of an operator called so: "Time in range" is time_in_range. */
export const functionName = (name: string) => {
  const snake = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!snake) return "my_function";
  return /^[0-9]/.test(snake) ? `f_${snake}` : snake;
};

/**
 * A custom operator's code: a Python function under @returns. Its tables are its positional
 * parameters, its settings those after the `*`, and the catalog reads both, with the columns
 * @returns names, when the operator is saved. The classes that run it are the engine's.
 */
export const starterCode = (fn: string) => `import pandas as pd


@returns(rows=int)
def ${fn}(table: pd.DataFrame, *, label: str = "") -> pd.DataFrame:
    """Counts the rows it reads."""
    return pd.DataFrame({"rows": [len(table)]})
`;

export const operatorKind: KindSpec = {
  kind: "operator",
  label: "Operator",
  plural: "Operators",
  icon: Blocks,
  accent: "bg-kind-operator/12 text-kind-operator",
  long: ["code", "description"],
  // What the catalog reads from the code when it saves the operator.
  hidden: ["inputPorts", "outputPorts", "propertiesSchema", "outputColumns", "nondeterministic"],
  /** A custom operator: a Python function, named after the operator. */
  defaultSpec: ({ name, description }) => {
    const fn = functionName(name);
    return {
      operatorType: fn,
      displayName: name,
      group: "Custom",
      ...(description ? { description } : {}),
      implementation: { python: { code: starterCode(fn), function: fn } },
    } satisfies OperatorSpec;
  },
  facts: r => {
    const spec = r.spec as Partial<OperatorSpec>;
    // A function that reads no table makes its rows: a source.
    const source = spec.implementation && spec.inputPorts?.length === 0 ? "source" : "";
    // A function that may give other rows for the same input is made again on every run.
    const fresh = spec.implementation?.python?.nondeterministic ? "nondeterministic" : "";
    return [spec.implementation ? "custom" : "engine", spec.group ?? "", source, fresh].filter(Boolean);
  },
};
