// Reading a compilation (POST /catalog/v1/workflows/{rid}/validate): each operator's
// input and output columns per port, and readable errors.

import type { Attribute, CompileResult } from "@texera/catalog-client/types";
import type { LogicalPlan } from "./plan";

export interface Compilation {
  /** Each operator's input columns, per input port (undefined while unknown). */
  inputs: Record<string, (Attribute[] | undefined)[]>;
  /** Each operator's output columns on its first port. */
  outputs: Record<string, Attribute[] | undefined>;
  /** Why an operator does not compile. */
  errors: Record<string, string>;
}

/**
 * Engine errors arrive as Java exception text ("java.lang.RuntimeException: Operator is
 * not configured properly: requirement failed: ..."); keep the part meant for people.
 */
export function readableError(message: string): string {
  let text = message.trim();
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text
      .replace(/^[\w.$]+(?:Exception|Error)(?::\s*|$)/, "")
      .replace(/^(?:Operator is not configured properly|requirement failed):\s*/i, "");
  }
  if (!text || /^null$/i.test(text)) return "Some settings are missing or invalid.";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const errorText = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const r = e as { message?: unknown; details?: unknown };
    if (typeof r.message === "string" && r.message) return r.message;
    if (typeof r.details === "string" && r.details) return r.details;
  }
  return "Error";
};

/** The schema of an output port; the engine keys ports as `<id>_false`, the catalog may key them `<id>`. */
const portSchema = (ports: Record<string, Attribute[] | null> | undefined, id: number) =>
  ports?.[`${id}_false`] ?? ports?.[String(id)] ?? undefined;

export function interpret(plan: LogicalPlan, result: Pick<CompileResult, "operatorOutputSchemas" | "operatorErrors">): Compilation {
  const schemas = result.operatorOutputSchemas ?? {};
  const inputs: Compilation["inputs"] = {};
  for (const link of plan.links) {
    const schema = portSchema(schemas[link.fromOpId], link.fromPortId.id) ?? undefined;
    const ports = inputs[link.toOpId] ?? [];
    ports[link.toPortId.id] ??= schema;
    inputs[link.toOpId] = ports;
  }
  const outputs: Compilation["outputs"] = {};
  for (const [opId, ports] of Object.entries(schemas)) outputs[opId] = portSchema(ports, 0) ?? undefined;
  const errors: Compilation["errors"] = {};
  for (const [opId, e] of Object.entries(result.operatorErrors ?? {})) errors[opId] = readableError(errorText(e));
  return { inputs, outputs, errors };
}
