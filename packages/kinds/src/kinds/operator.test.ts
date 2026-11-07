import { describe, expect, test } from "vitest";
import { functionName, operatorKind, starterCode } from "./operator";

describe("a new operator", () => {
  test("is a Python function named after it, never a class", () => {
    const spec = operatorKind.defaultSpec?.({ name: "Time in range", description: "TIR per patient" }, {}) as {
      operatorType: string;
      implementation: { python: { code: string; function: string } };
      inputPorts?: unknown;
    };
    expect(spec.operatorType).toBe("time_in_range");
    expect(spec.implementation.python.function).toBe("time_in_range");
    expect(spec.implementation.python.code).toBe(starterCode("time_in_range"));
    expect(spec.implementation.python.code).toContain("@returns(rows=int)\ndef time_in_range(table: pd.DataFrame, *,");
    expect(spec.implementation.python.code).not.toMatch(/class |UDFOperatorV2|process_tuple/);
    // Its ports, settings and columns are what the catalog reads from the code.
    expect(spec.inputPorts).toBeUndefined();
  });

  test("gets a Python name from any name", () => {
    expect(functionName("CGM metrics")).toBe("cgm_metrics");
    expect(functionName("  30-day readmission risk ")).toBe("f_30_day_readmission_risk");
    expect(functionName("!!!")).toBe("my_function");
  });

  test("says it is a source when it reads no table", () => {
    const facts = (spec: object) => operatorKind.facts?.({ spec } as never) ?? [];
    expect(facts({ implementation: { python: { code: "" } }, inputPorts: [], group: "Custom" })).toEqual(["custom", "Custom", "source"]);
    expect(facts({ implementation: { python: { code: "", nondeterministic: true } }, inputPorts: [{ portID: "input-0" }] })).toEqual([
      "custom",
      "nondeterministic",
    ]);
    expect(facts({ group: "Core", inputPorts: [] })).toEqual(["engine", "Core"]);
  });
});
