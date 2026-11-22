import type { ExecutionStatus } from "@texera/catalog-client/types";
import type { WorkflowSpec } from "@texera/workflow-model";
import { describe, expect, it } from "vitest";
import { asOf, executionOverlay, isChart, keptResult } from "./overlay";

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
    expect(overlay.avg?.results).toEqual([
      { port: "output-0", rows: 3 },
      { port: "output-1", rows: 1 },
    ]);
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
        reused: [
          {
            operatorID: "avg",
            portID: "output-0",
            from: "texera://workflows/w/executions/e1/operators/avg/ports/output-0",
          },
        ],
        skipped: ["scan"],
      }
    );
    expect(overlay.avg).toMatchObject({
      status: "completed",
      rowsOut: 2,
      reusedFrom: "texera://workflows/w/executions/e1",
    });
    expect(overlay.scan).toEqual({ skipped: true });
  });

  it("is empty for no execution", () => {
    expect(executionOverlay(undefined)).toEqual({});
  });
});

describe("a result kept", () => {
  it("is one the catalog keeps a table for", () => {
    expect(keptResult({ operatorID: "scan", portID: "output-0", table: "vfs:///x" })).toBe(false);
    expect(keptResult({ operatorID: "avg", portID: "output-0", table: "e_1.avg_output_0" })).toBe(true);
  });
});

describe("an execution of another version, as the workflow on screen shows it", () => {
  const op = (operatorID: string, operatorProperties: Record<string, unknown> = {}) =>
    ({ operatorID, operatorType: "filter", operatorProperties }) as WorkflowSpec["operators"][number];
  const link = (from: string, to: string) => ({
    linkID: `${from}-${to}`,
    source: { operatorID: from, portID: "output-0" },
    target: { operatorID: to, portID: "input-0" },
  });
  const ran: WorkflowSpec = { operators: [op("scan"), op("avg", { by: "s" })], links: [link("scan", "avg")] };

  it("says nothing of how a changed operator did, and that its results are of the version that ran", () => {
    const now: WorkflowSpec = { ...ran, operators: [op("scan"), op("avg", { by: "t" })] };
    const shown = asOf(executionOverlay(status), ran, 3, now);
    expect(shown.avg).toEqual({
      results: [
        { port: "output-0", rows: 3 },
        { port: "output-1", rows: 1 },
      ],
      stale: 3,
    });
    expect(shown.scan).toMatchObject({ status: "completed", rowsOut: 150 });
  });

  it("is the execution as it was where nothing changed", () => {
    expect(asOf(executionOverlay(status), ran, 3, ran)).toEqual(executionOverlay(status));
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
