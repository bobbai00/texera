import { describe, expect, it } from "vitest";
import { baseUri, fileUri, href, kindOfPlural, parsePath, parseUri, pathOf, pluralOf, shortUri, uriOf, versionOf } from "./uri";

const W = "0b7a1c2d-0000-4000-8000-000000000001";
const E = "0b7a1c2d-0000-4000-8000-000000000002";

describe("uri", () => {
  it("parses flat, versioned and subresource names", () => {
    expect(parseUri(`texera://datasets/${W}`)).toEqual({ ref: { kind: "dataset", rid: W } });
    expect(parseUri(`texera://datasets/${W}@2/files/dir/iris.csv`)).toEqual({ ref: { kind: "dataset", rid: W, vno: 2 }, subresource: "files/dir/iris.csv" });
    expect(parseUri(`texera://agent-templates/${W}@1`)?.ref).toEqual({ kind: "agent-template", rid: W, vno: 1 });
    // The deployment's settings are Texera's, a project's: no name stands for them.
    expect(parseUri("texera://settings")).toBeUndefined();
  });

  it("parses the nested kind and its ports", () => {
    expect(parseUri(`texera://workflows/${W}/executions/${E}`)).toEqual({ ref: { kind: "execution", rid: E, parent: W } });
    expect(parseUri(`texera://workflows/${W}/executions/${E}/operators/avg/ports/output-0`)).toEqual({
      ref: { kind: "execution", rid: E, parent: W },
      subresource: "operators/avg/ports/output-0",
    });
    expect(parseUri(`texera://workflows/${W}@3`)?.ref).toEqual({ kind: "workflow", rid: W, vno: 3 });
  });

  it("rejects what is not a name", () => {
    expect(parseUri("https://example.org")).toBeUndefined();
    expect(parseUri("texera://nothing/x")).toBeUndefined();
    expect(parseUri("texera://datasets")).toBeUndefined();
    expect(parseUri(`texera://datasets/${W}@zero`)).toBeUndefined();
    expect(parsePath(`workflows/${W}`)?.ref.kind).toBe("workflow");
  });

  it("writes names back and builds links", () => {
    expect(uriOf({ kind: "dataset", rid: W, vno: 2 })).toBe(`texera://datasets/${W}@2`);
    expect(uriOf({ kind: "execution", rid: E, parent: W })).toBe(`texera://workflows/${W}/executions/${E}`);
    expect(uriOf({ kind: "execution", rid: E })).toBe(`texera://executions/${E}`);
    expect(fileUri({ kind: "dataset", rid: W, vno: 1 }, "iris.csv")).toBe(`texera://datasets/${W}@1/files/iris.csv`);
    expect(href({ kind: "workflow", rid: W })).toBe(`/workflows/${W}`);
    expect(href({ kind: "dataset", rid: W, vno: 3 })).toBe(`/datasets/${W}?vno=3`);
    expect(href({ kind: "execution", rid: E, parent: W })).toBe(`/workflows/${W}/executions/${E}`);
    expect(baseUri(`texera://skills/${W}@4`)).toBe(`texera://skills/${W}`);
    expect(versionOf(`texera://skills/${W}@4`)).toBe(4);
    expect(versionOf(`texera://skills/${W}`)).toBeUndefined();
  });

  it("knows plurals and shortens names for labels", () => {
    expect(pluralOf("mcp-server")).toBe("mcp-servers");
    expect(kindOfPlural("computing-units")).toBe("computing-unit");
    expect(kindOfPlural("nope")).toBeUndefined();
    expect(shortUri(`texera://datasets/${W}@2/files/iris.csv`)).toBe("datasets/0b7a1c2d@2/files/iris.csv");
    expect(shortUri("plain text")).toBe("plain text");
  });
});
