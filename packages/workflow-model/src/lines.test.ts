import { describe, expect, it } from "vitest";
import { applyLines, callOf, type LineError, linesOf, parseLines, printValue } from "./lines";
import type { WorkflowOperator, WorkflowSpec } from "./types";

const EDIT = `set readings: scan(file="texera://datasets/d1@4/files/cgm.csv")
set night: filter(readings, where="hour(taken_at) >= 22 or hour(taken_at) < 6")  # overnight
set lows: aggregate(night, by=["patient_id"],
                    outputs=["n = count(*)", "lows = count_if(glucose < 70)"])
set risk: join(lows, labs, on=["patient_id"], how='left')
set labs: scan(file="texera://datasets/d2@1/files/labs.csv", header=True)
`;

const empty: WorkflowSpec = { operators: [], links: [] };

describe("parseLines", () => {
  it("reads set and delete lines, inputs before settings, values of every kind", () => {
    const lines = parseLines(`${EDIT}delete old\n`);
    expect(lines.map(l => [l.kind, l.id, l.line])).toEqual([
      ["set", "readings", 1],
      ["set", "night", 2],
      ["set", "lows", 3],
      ["set", "risk", 5],
      ["set", "labs", 6],
      ["delete", "old", 7],
    ]);
    expect(lines[2]).toEqual({
      kind: "set",
      id: "lows",
      op: "aggregate",
      inputs: ["night"],
      settings: { by: ["patient_id"], outputs: ["n = count(*)", "lows = count_if(glucose < 70)"] },
      line: 3,
    });
    expect(lines[3]).toMatchObject({ inputs: ["lows", "labs"], settings: { on: ["patient_id"], how: "left" } });
    expect(parseLines(`set x: limit(y, n=5, offset=-1, keep=None, m={"a": [1, 2.5], 'b': false})`)[0]).toMatchObject({
      settings: { n: 5, offset: -1, keep: null, m: { a: [1, 2.5], b: false } },
    });
  });

  it("says what is wrong and on which line", () => {
    const wrong = (text: string) => {
      try {
        parseLines(text);
      } catch (e) {
        return (e as LineError).message;
      }
      return "no error";
    };
    expect(wrong("set night_lows: filter(x, where='y')")).toBe(
      "line 1: an operator id may not contain '_'; use '-', as in night-lows"
    );
    expect(wrong("set a: filter(x, where='y'\nset b: limit(a, n=1)")).toMatch(/^line 2: /);
    expect(wrong("make a: filter(x)")).toBe("line 1: a line starts with set or delete, not 'make'");
    expect(wrong("set a: filter(where='y', x)")).toBe("line 1: the inputs come before the settings");
    expect(wrong("set a: filter(x, where=glucose < 70)")).toBe(
      "line 1: '<' has no meaning here; an expression is text, so put it in quotes: where=\"glucose < 70\""
    );
    expect(wrong("set a: filter(x, where=glucose)")).toBe("line 1: 'glucose' is not a value: put text in quotes");
    expect(wrong("set a: filter(x, where='unclosed)")).toMatch(/not closed/);
  });
});

describe("applyLines", () => {
  it("adds operators and links them in port order, forward references allowed", () => {
    const spec = applyLines(empty, parseLines(EDIT));
    expect(spec.operators.map(o => o.operatorID)).toEqual(["readings", "night", "lows", "risk", "labs"]);
    expect(spec.links.map(l => [l.source.operatorID, l.target.operatorID, l.target.portID])).toEqual([
      ["readings", "night", "input-0"],
      ["night", "lows", "input-0"],
      ["lows", "risk", "input-0"],
      ["labs", "risk", "input-1"],
    ]);
    expect(linesOf(spec)).toEqual([
      'set readings: scan(file="texera://datasets/d1@4/files/cgm.csv")',
      'set night: filter(readings, where="hour(taken_at) >= 22 or hour(taken_at) < 6")',
      'set lows: aggregate(night, by=["patient_id"], outputs=["n = count(*)", "lows = count_if(glucose < 70)"])',
      'set labs: scan(file="texera://datasets/d2@1/files/labs.csv", header=true)',
      'set risk: join(lows, labs, on=["patient_id"], how="left")',
    ]);
  });

  it("replaces an operator whole and keeps the ones reading it, with what the canvas shows of it", () => {
    const spec = applyLines(empty, parseLines(EDIT));
    spec.operators[1] = { ...(spec.operators[1] as WorkflowOperator), viewResult: true };
    const next = applyLines(spec, parseLines(`set night: filter(readings, where="hour(taken_at) < 6")`));
    expect(next.operators.find(o => o.operatorID === "night")).toEqual({
      viewResult: true,
      operatorID: "night",
      operatorType: "filter",
      operatorProperties: { where: "hour(taken_at) < 6" },
    });
    expect(next.links.filter(l => l.source.operatorID === "night").map(l => l.target.operatorID)).toEqual(["lows"]);
    expect(callOf(next, next.operators.find(o => o.operatorID === "risk") as WorkflowOperator)).toBe(
      'join(lows, labs, on=["patient_id"], how="left")'
    );
  });

  it("refuses the whole edit when a line reads what is not there or deletes what is still read", () => {
    const spec = applyLines(empty, parseLines(EDIT));
    expect(() => applyLines(spec, parseLines("set x: limit(nothing, n=1)"))).toThrow(
      "line 1: x reads nothing, which is not in the workflow"
    );
    expect(() => applyLines(spec, parseLines("delete night"))).toThrow(
      "line 1: lows reads night; delete it too, or set it to read something else"
    );
    expect(() =>
      applyLines(spec, parseLines("delete night\nset lows: aggregate(night, outputs=['n = count(*)'])"))
    ).toThrow("line 2: lows reads night, which line 1 deletes");
    expect(() => applyLines(spec, parseLines("delete ghost"))).toThrow("line 1: there is no operator ghost");
    expect(() => applyLines(spec, parseLines("set a: limit(readings, n=1)\nset a: limit(readings, n=2)"))).toThrow(
      "line 2: a is named twice in this edit"
    );
    // Deleting a reader and what it reads together is fine.
    expect(
      applyLines(spec, parseLines("delete risk\ndelete lows\ndelete night")).operators.map(o => o.operatorID)
    ).toEqual(["readings", "labs"]);
  });

  it("prints values as the lines read them", () => {
    expect(printValue({ a: [1, "x"], b: null, c: true })).toBe('{"a": [1, "x"], "b": null, "c": true}');
  });
});
