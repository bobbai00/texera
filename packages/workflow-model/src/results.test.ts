import { describe, expect, it } from "vitest";
import { CARD } from "./layout";
import { changedSince, RESULT_CHIP, RESULT_HANDLE, resultLayer, resultRoom } from "./results";
import type { WorkflowSpec } from "./types";

const op = (operatorID: string, operatorProperties: Record<string, unknown> = {}, more: object = {}) =>
  ({ operatorID, operatorType: "filter", operatorProperties, ...more }) as WorkflowSpec["operators"][number];
const link = (from: string, to: string, port = "input-0") => ({
  linkID: `${from}-${to}-${port}`,
  source: { operatorID: from, portID: "output-0" },
  target: { operatorID: to, portID: port },
});
const flow = (operators: WorkflowSpec["operators"], links: WorkflowSpec["links"]): WorkflowSpec => ({
  operators,
  links,
});

describe("the results a canvas draws", () => {
  const spec = flow(
    [
      op("scan", {}, { outputPorts: [{ portID: "output-0" }] }),
      op(
        "split",
        {},
        {
          outputPorts: [
            { portID: "output-0", displayName: "kept" },
            { portID: "output-1", displayName: "dropped" },
          ],
        }
      ),
    ],
    [link("scan", "split")]
  );
  const positions = { scan: { x: 0, y: 100 }, split: { x: 320, y: 100 } };

  it("stands each one under its card's right edge, joined to its port by a dashed line that cannot be picked", () => {
    const { nodes, edges } = resultLayer(
      spec,
      positions,
      { scan: { results: [{ port: "output-0", rows: 150 }] } },
      () => 64
    );
    expect(nodes).toEqual([
      expect.objectContaining({
        id: "result:scan:output-0",
        type: "result",
        position: { x: CARD.width - RESULT_CHIP.width / 2, y: 100 + 64 + RESULT_CHIP.gap },
        selectable: false,
        draggable: false,
        data: { operatorID: "scan", port: "output-0", rows: 150 },
      }),
    ]);
    expect(edges).toEqual([
      expect.objectContaining({
        source: "scan",
        sourceHandle: "output-0",
        target: "result:scan:output-0",
        targetHandle: RESULT_HANDLE,
        selectable: false,
        style: expect.objectContaining({ strokeDasharray: "4 4" }),
      }),
    ]);
  });

  it("names the port of an operator with several, puts them side by side, and says a stale one's version", () => {
    const { nodes } = resultLayer(
      spec,
      positions,
      { split: { results: [{ port: "output-0" }, { port: "output-1", rows: 3 }], stale: 2 } },
      id => (id === "split" ? 90 : 64)
    );
    expect(nodes.map(n => [n.data.label, n.position, n.data.stale])).toEqual([
      ["kept", { x: 320 + CARD.width - RESULT_CHIP.width / 2, y: 100 + 90 + RESULT_CHIP.gap }, 2],
      [
        "dropped",
        { x: 320 + CARD.width - RESULT_CHIP.width / 2 - RESULT_CHIP.width - 8, y: 100 + 90 + RESULT_CHIP.gap },
        2,
      ],
    ]);
  });

  it("takes room under the cards only when some operator has a result", () => {
    expect(resultRoom(undefined)).toBe(0);
    expect(resultRoom({ scan: { status: "completed" } })).toBe(0);
    expect(resultRoom({ scan: { results: [{ port: "output-0" }] } })).toBe(RESULT_CHIP.height + RESULT_CHIP.gap);
  });
});

describe("which results the workflow on screen no longer puts out", () => {
  const ran = flow(
    [op("scan", { file: "a.csv" }), op("lows", { where: "x < 1" }), op("means", { by: ["s"] }), op("other")],
    [link("scan", "lows"), link("lows", "means")]
  );

  it("is none when nothing that makes rows changed: names, places and the eye change no result", () => {
    const renamed = flow(
      ran.operators.map(o => ({ ...o, customDisplayName: "named", viewResult: true })),
      ran.links
    );
    expect(changedSince(ran, { ...renamed, layout: { scan: { x: 9, y: 9 } } })).toEqual(new Set());
  });

  it("is an operator whose settings changed, and every one that reads from it however far back", () => {
    const now = flow(
      ran.operators.map(o => (o.operatorID === "lows" ? { ...o, operatorProperties: { where: "x < 2" } } : o)),
      ran.links
    );
    expect(changedSince(ran, now)).toEqual(new Set(["lows", "means"]));
  });

  it("reads settings whatever the order of their keys", () => {
    const before = flow([op("a", { x: 1, y: { p: 1, q: 2 } })], []);
    expect(changedSince(before, flow([op("a", { y: { q: 2, p: 1 }, x: 1 })], []))).toEqual(new Set());
  });

  it("is an operator new since, one turned off, and one that reads from elsewhere", () => {
    const now = flow(
      [...ran.operators.map(o => (o.operatorID === "other" ? { ...o, isDisabled: true } : o)), op("fresh")],
      [link("scan", "lows"), link("scan", "means")]
    );
    expect(changedSince(ran, now)).toEqual(new Set(["means", "other", "fresh"]));
  });
});
