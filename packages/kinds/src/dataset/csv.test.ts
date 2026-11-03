import { describe, expect, it } from "vitest";
import { inferType, parseCsv, previewCsv } from "./csv";

describe("csv", () => {
  it("parses quoted fields, doubled quotes and newlines inside quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "2"],
    ]);
  });

  it("drops a final row cut off by a truncated read", () => {
    expect(parseCsv("a,b\n1,2\n3,", { truncated: true })).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("infers the types a CSV scan would", () => {
    expect(inferType(["1", "2", ""])).toBe("integer");
    expect(inferType(["1", "99999999999"])).toBe("long");
    expect(inferType(["1.5", "2"])).toBe("double");
    expect(inferType(["true", "FALSE"])).toBe("boolean");
    expect(inferType(["a", "1"])).toBe("string");
    expect(inferType([""])).toBe("string");
  });

  it("builds a typed preview with a row limit", () => {
    const preview = previewCsv("name,age\nann,3\nbob,4\ncy,5", { limit: 2 });
    expect(preview.columns).toEqual([
      { name: "name", type: "string" },
      { name: "age", type: "integer" },
    ]);
    expect(preview.rows).toHaveLength(2);
  });
});
