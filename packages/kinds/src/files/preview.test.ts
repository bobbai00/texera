import { describe, expect, it } from "vitest";
import { previewKind } from "./preview";

describe("how a file is previewed", () => {
  it("draws markdown as a page, wherever it is and however its name is cased", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("docs/Codebook.MD")).toBe("markdown");
    expect(previewKind("notes.markdown")).toBe("markdown");
  });
  it("shows what a file scan reads as a table", () => {
    expect(previewKind("iris.csv")).toBe("table");
    expect(previewKind("cells.tsv")).toBe("table");
    expect(previewKind("readings.txt")).toBe("table");
  });
  it("shows what reads as text as text", () => {
    expect(previewKind("contract.json")).toBe("text");
    expect(previewKind("model.py")).toBe("text");
    expect(previewKind("LICENSE")).toBe("text");
    expect(previewKind("docs/README")).toBe("text");
  });
  it("previews nothing else: a fitted model, a picture, a name that only ends like one", () => {
    expect(previewKind("model.joblib")).toBe("none");
    expect(previewKind("figure.png")).toBe("none");
    expect(previewKind("readme.md.bak")).toBe("none");
    expect(previewKind("mdfile")).toBe("none");
  });
});
