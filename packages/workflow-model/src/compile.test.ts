import { describe, expect, it } from "vitest";
import { interpret, readableError } from "./compile";
import type { LogicalPlan } from "./plan";

const plan: LogicalPlan = {
  operators: [],
  links: [
    {
      fromOpId: "scan",
      fromPortId: { id: 0, internal: false },
      toOpId: "join",
      toPortId: { id: 1, internal: false },
    },
  ],
  opsToViewResult: [],
  opsToReuseResult: [],
};
const columns = [{ attributeName: "region", attributeType: "string" }];

describe("compilation", () => {
  it("maps each link's upstream output schema onto the downstream input port", () => {
    const result = interpret(plan, {
      operatorOutputSchemas: { scan: { "0_false": columns } },
      operatorErrors: { join: { message: "java.lang.IllegalArgumentException: requirement failed: pick a key" } },
    });
    expect(result.inputs.join).toEqual([undefined, columns]);
    expect(result.outputs.scan).toEqual(columns);
    expect(result.errors.join).toBe("Pick a key");
  });

  it("accepts ports keyed by bare id, and errors given as plain strings", () => {
    const result = interpret(plan, {
      operatorOutputSchemas: { scan: { "0": columns } },
      operatorErrors: { scan: "File not found" },
    });
    expect(result.inputs.join).toEqual([undefined, columns]);
    expect(result.errors.scan).toBe("File not found");
  });

  it("reads ports keyed as the catalog keys them, by port id", () => {
    const result = interpret(plan, { operatorOutputSchemas: { scan: { "output-0": columns } }, operatorErrors: {} });
    expect(result.inputs.join).toEqual([undefined, columns]);
    expect(result.outputs.scan).toEqual(columns);
  });

  it("says in words why an operator's input has no columns: a link missing, or what feeds it", () => {
    const missing = "org.apache.texera.amber.core.workflow.SchemaNotAvailableException: schema is not available";
    const errorsOf = (links: LogicalPlan["links"], inputCounts: Record<string, number>) =>
      interpret(
        { operatorIds: ["scan", "join"], links, inputCounts },
        { operatorOutputSchemas: {}, operatorErrors: { join: missing } }
      ).errors.join;
    const link = (to: number) => ({
      fromOpId: "scan",
      fromPortId: { id: 0, internal: false as const },
      toOpId: "join",
      toPortId: { id: to, internal: false as const },
    });
    expect(errorsOf([], { join: 1 })).toBe("Needs an input: link an operator to it.");
    expect(errorsOf([], { join: 2 })).toBe("Needs its inputs: link an operator to each of them.");
    expect(errorsOf([link(1)], { join: 2 })).toBe("Needs another input: link an operator to each of its inputs.");
    expect(errorsOf([link(0)], { join: 1 })).toBe("Waits for its input: fix the operator before it.");
  });

  it("keeps the readable part of engine exception text", () => {
    expect(
      readableError(
        "java.lang.RuntimeException: Operator is not configured properly: requirement failed: Each sort key must have an attribute selected."
      )
    ).toBe("Each sort key must have an attribute selected.");
    expect(
      readableError("org.apache.texera.amber.core.workflow.SchemaNotAvailableException: schema is not available")
    ).toBe("Schema is not available");
    expect(readableError("scala.MatchError: null")).toBe("Some settings are missing or invalid.");
    expect(readableError("plain message")).toBe("Plain message");
  });
});
