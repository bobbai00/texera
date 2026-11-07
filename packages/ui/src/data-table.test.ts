import { describe, expect, it } from "vitest";
import { cell } from "./data-table";

describe("a cell of a result", () => {
  it("says a double without the noise of binary fractions", () => {
    expect(cell(5.551999999999999, "double")).toBe("5.552");
    expect(cell(1.462, "double")).toBe("1.462");
    expect(cell(0.1 + 0.2, "double")).toBe("0.3");
    expect(cell(123456789.123456, "double")).toBe("123456789.123");
    expect(cell(1e-9, "double")).toBe("1e-9");
  });

  it("leaves everything else as it is", () => {
    expect(cell(5.551999999999999, "string")).toBe("5.551999999999999");
    expect(cell(42, "integer")).toBe("42");
    expect(cell(null, "double")).toBe("");
    expect(cell({ a: 1 })).toBe('{"a":1}');
    expect(cell(Number.NaN, "double")).toBe("NaN");
  });
});
