import type { ExecutionStatus } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { defaultResult, executionOverlay, isChart, keptResult } from "./overlay";

const status: ExecutionStatus = {
  phase: "running",
  operators: {
    scan: { state: "Completed", rowsIn: 0, rowsOut: 150 },
    avg: { state: "Running", rowsIn: 120, rowsOut: 2 },
    udf: { state: "Failed", error: { code: "failed", message: "name 'x' is not defined" } },
    late: { state: "Ready" },
  },
  ports: [
    // An execution of an earlier release may list a port the engine stored for its own
    // schedule, with no table of the catalog's: that is no result.
    {
      operatorID: "scan",
      portID: "output-0",
      rows: 150,
      table: "vfs:///wid/1/eid/2/globalportid/(logicalOpId=scan)/result",
    },
    { operatorID: "avg", portID: "output-0", rows: 3, table: "e_1.avg_output_0" },
    { operatorID: "avg", portID: "output-1", rows: 1, table: "e_1.avg_output_1" },
  ],
};

describe("what the cards say of an execution", () => {
  it("is each operator's state, the rows it read and put out, and why it failed", () => {
    const overlay = executionOverlay(status);
    expect(overlay.scan).toMatchObject({ status: "completed", rowsIn: 0, rowsOut: 150 });
    expect(overlay.avg).toMatchObject({ status: "running", rowsIn: 120, rowsOut: 2 });
    expect(overlay.udf).toMatchObject({ status: "failed", error: "name 'x' is not defined" });
    expect(overlay.late).toMatchObject({ status: "waiting" });
  });

  it("names the output ports whose result is kept, and no other", () => {
    const overlay = executionOverlay(status);
    expect(overlay.avg?.results).toEqual(["output-0", "output-1"]);
    expect(overlay.scan?.results).toBeUndefined();
    expect(overlay.udf?.results).toBeUndefined();
  });

  it("names none once the results expired, and still says what each operator did", () => {
    const overlay = executionOverlay({ ...status, resultsExpiredAt: "2026-11-06T00:00:00Z" });
    expect(overlay.avg?.results).toBeUndefined();
    expect(overlay.avg?.rowsOut).toBe(2);
  });

  it("says which operators read an earlier run's rows, from which run, and which did not run", () => {
    const overlay = executionOverlay(
      { phase: "completed", operators: { avg: { state: "Completed", rowsOut: 2 } } },
      {
        reused: [{ operatorID: "avg", portID: "output-0", from: "texera://workflows/w/executions/e1/operators/avg/ports/output-0" }],
        skipped: ["scan"],
      }
    );
    expect(overlay.avg).toMatchObject({ status: "completed", rowsOut: 2, reusedFrom: "texera://workflows/w/executions/e1" });
    expect(overlay.scan).toEqual({ skipped: true });
  });

  it("is empty for no execution", () => {
    expect(executionOverlay(undefined)).toEqual({});
  });
});

describe("the result on screen when nobody chose one", () => {
  it("is the last result kept: what the workflow was run to get", () => {
    expect(defaultResult(status.ports ?? [])).toBe("avg:output-1");
    expect(keptResult({ operatorID: "scan", portID: "output-0", table: "vfs:///x" })).toBe(false);
    expect(keptResult({ operatorID: "avg", portID: "output-0", table: "e_1.avg_output_0" })).toBe(true);
  });

  it("is none when nothing is kept", () => {
    expect(defaultResult([{ operatorID: "scan", portID: "output-0", table: "vfs:///x" }])).toBeNull();
    expect(defaultResult([])).toBeNull();
  });
});

describe("a result that is a picture", () => {
  it("is one whose only column is the page a visualization operator drew", () => {
    expect(isChart([{ attributeName: "html-content", attributeType: "string" }])).toBe(true);
    expect(isChart([{ attributeName: "noc", attributeType: "string" }])).toBe(false);
    expect(
      isChart([
        { attributeName: "html-content", attributeType: "string" },
        { attributeName: "noc", attributeType: "string" },
      ])
    ).toBe(false);
    expect(isChart([])).toBe(false);
  });
});
