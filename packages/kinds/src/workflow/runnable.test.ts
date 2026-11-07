import { describe, expect, it } from "vitest";
import { CatalogError } from "../api";
import { isRefusal, notRunnable, refusedOperator } from "./runnable";

const refused = (needs: string, operator?: string) =>
  new CatalogError(403, "the catalog's own words", "forbidden", { needs, ...(operator ? { operator } : {}) });
const nameOf = (id: string) => ({ scan: "CSV File Scan", call: "Call an API" })[id] ?? id;

describe("why a person may not run a workflow", () => {
  it("names the operator and the file a dataset not shared with them holds", () => {
    const error = refused("texera://datasets/0b7e5c2a-1111-4c3e-9a1b-2c3d4e5f6a7b@1/files/iris.csv", "scan");
    expect(isRefusal(error)).toBe(true);
    expect(refusedOperator(error)).toBe("scan");
    expect(notRunnable(error, nameOf)).toBe(
      "CSV File Scan reads iris.csv, from a dataset not shared with you. Ask the workflow's owner to share it with you."
    );
  });

  it("says what to do about a unit, a warehouse, a credential or a custom operator", () => {
    const rid = "0b7e5c2a-1111-4c3e-9a1b-2c3d4e5f6a7b";
    expect(notRunnable(refused(`texera://computing-units/${rid}`), nameOf)).toMatch(
      /^You may not run on this computing unit\. Pick another/
    );
    expect(notRunnable(refused(`texera://warehouses/${rid}`), nameOf)).toMatch(
      /^You may not keep results in this warehouse/
    );
    expect(notRunnable(refused(`texera://credentials/${rid}`, "call"), nameOf)).toBe(
      "Call an API uses a credential you may not use. Ask its owner to share it with you."
    );
    expect(notRunnable(refused(`texera://operators/${rid}@2`), nameOf)).toMatch(/custom operator not shared with you/);
  });

  it("keeps the catalog's words for anything else, and is no refusal for other errors", () => {
    expect(notRunnable(new CatalogError(403, "the caller may not do this", "forbidden"), nameOf)).toBe(
      "the caller may not do this"
    );
    expect(isRefusal(new CatalogError(409, "conflict"))).toBe(false);
    expect(isRefusal(new Error("x"))).toBe(false);
  });
});
