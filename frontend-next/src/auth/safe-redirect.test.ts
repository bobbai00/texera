import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safe-redirect";

describe("safeRedirect", () => {
  it("keeps same-origin paths", () => {
    expect(safeRedirect("/c/abc?panel=w:1")).toBe("/c/abc?panel=w:1");
  });
  it("drops anything that could leave the app", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/a\nb", "", 3, null]) {
      expect(safeRedirect(bad)).toBeUndefined();
    }
  });
});
