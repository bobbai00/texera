import { describe, expect, it } from "vitest";
import { emptyValue, fieldType, properties, prune, specSchema } from "./schema";

describe("spec schemas", () => {
  it("finds every kind's spec in the bundle and classifies its fields", () => {
    const profile = specSchema("profile");
    expect(profile).toBeDefined();
    expect(fieldType(profile?.properties?.packages ?? {})).toBe("strings");
    expect(fieldType(profile?.properties?.memory ?? {})).toBe("string");
    expect(fieldType(profile?.properties?.gpu ?? {})).toBe("number");
    const mcp = specSchema("mcp-server");
    expect(fieldType(mcp?.properties?.headers ?? {})).toBe("map");
    const cred = specSchema("credential");
    expect(fieldType(cred?.properties?.kind ?? {})).toBe("enum");
    const tpl = specSchema("agent-template");
    expect(fieldType(tpl?.properties?.skills ?? {})).toBe("strings");
    expect(fieldType(tpl?.properties?.mcpServers ?? {})).toBe("json");
    expect(fieldType(specSchema("model-endpoint")?.properties?.maxOutputTokens ?? {})).toBe("number");
    expect(fieldType({ type: "boolean" })).toBe("boolean");
  });

  it("lists required properties first and builds an empty value for them", () => {
    const [first] = properties(specSchema("mcp-server") ?? {});
    expect(first?.[0]).toBe("url");
    expect(emptyValue(specSchema("credential") ?? {})).toEqual({ kind: "api_key" });
    expect(emptyValue(specSchema("skill") ?? {})).toEqual({ name: "", description: "", body: "" });
  });

  it("prunes empty optional fields but keeps required ones", () => {
    const pruned = prune({ url: "http://x", headers: {}, builtin: "", extra: undefined }, specSchema("mcp-server") ?? {});
    expect(pruned).toEqual({ url: "http://x" });
    expect(prune({ packages: [], memory: "", cpu: "2" }, specSchema("profile") ?? {})).toEqual({ cpu: "2" });
  });
});
