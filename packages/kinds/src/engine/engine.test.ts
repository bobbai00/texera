import { describe, expect, it } from "vitest";
import { engineSocketUrl, WorkflowRunner } from "./engine";

describe("engine socket", () => {
  it("reaches the unit through the gateway with the token as a query parameter", () => {
    const url = new URL(engineSocketUrl("unit-1", "wf-9", "tok", "http://localhost:8088/w/wf-9"));
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/units/unit-1/wsapi/workflow-websocket");
    expect(url.searchParams.get("wid")).toBe("wf-9");
    expect(url.searchParams.get("cuid")).toBe("unit-1");
    expect(url.searchParams.get("access_token")).toBe("tok");
  });

  it("folds engine frames into the run snapshot", () => {
    const runner = new WorkflowRunner("unit-1", "wf-9");
    runner.receive({ type: "WorkflowStateEvent", state: "Running" });
    runner.receive({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { scan: { operatorState: "Completed", aggregatedInputRowCount: 0, aggregatedOutputRowCount: 42 } },
    });
    runner.receive({
      type: "WebResultUpdateEvent",
      updates: { scan: { mode: { type: "PaginationMode" }, totalNumTuples: 42 } },
    });
    runner.receive({ type: "ConsoleUpdateEvent", operatorId: "udf", messages: [{ msgType: { name: "PRINT" }, title: "", message: "hi" }] });
    const s = runner.getSnapshot();
    expect(s.state).toBe("Running");
    expect(s.operators.scan?.outputRows).toBe(42);
    expect(s.outputs.scan).toEqual({ kind: "table", total: 42, revision: 1 });
    expect(s.console.udf?.[0]?.message).toBe("hi");
    runner.receive({ type: "WorkflowErrorEvent", fatalErrors: [{ message: "boom", operatorId: "unknown operator" }] });
    expect(runner.getSnapshot().state).toBe("Failed");
    expect(runner.getSnapshot().errors[0]?.operatorId).toBeUndefined();
  });
});
