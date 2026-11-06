import { describe, expect, it } from "vitest";
import { CatalogError } from "../api";
import { whyNot } from "./OpenError";

describe("why a resource's page cannot be shown", () => {
  it("tells not being allowed and not existing apart from a failure", () => {
    expect(whyNot({ code: "forbidden", message: "forbidden" })).toBe("forbidden");
    expect(whyNot(new CatalogError(403, "forbidden", "forbidden"))).toBe("forbidden");
    expect(whyNot(new CatalogError(403, "no"))).toBe("forbidden");
    expect(whyNot({ code: "not_found", message: "workflow not found" })).toBe("not_found");
    expect(whyNot(new CatalogError(404, "gone"))).toBe("not_found");
    expect(whyNot(new Error("network down"))).toBeUndefined();
    expect(whyNot({ code: "unavailable", message: "try later" })).toBeUndefined();
  });
});
