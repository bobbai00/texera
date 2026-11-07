import { describe, expect, it } from "vitest";
import { CatalogError, catalogErrorOf } from "./api";

const answer = (status: number, statusText = "") => new Response(null, { status, statusText });

describe("what the catalog refused, as the app reads it", () => {
  it("is a CatalogError with the status, the message, the code and the details of the body", () => {
    const error = catalogErrorOf(
      { code: "forbidden", message: "operator scan reads x", details: { needs: "texera://datasets/d" } },
      answer(403)
    );
    expect(error).toBeInstanceOf(CatalogError);
    const e = error as CatalogError;
    expect([e.status, e.code, e.message]).toEqual([403, "forbidden", "operator scan reads x"]);
    expect(e.details).toEqual({ needs: "texera://datasets/d" });
  });

  it("says the status when the body says nothing", () => {
    const e = catalogErrorOf("", answer(404, "Not Found")) as CatalogError;
    expect([e.status, e.message]).toEqual([404, "Not Found"]);
    expect((catalogErrorOf(undefined, answer(502)) as CatalogError).message).toBe("HTTP 502");
  });

  it("leaves alone what is already one, a failure with no response, and an answer that was fine", () => {
    const already = new CatalogError(409, "conflict");
    expect(catalogErrorOf(already, answer(409))).toBe(already);
    const network = new TypeError("Failed to fetch");
    expect(catalogErrorOf(network, undefined)).toBe(network);
    expect(catalogErrorOf("odd", answer(200))).toBe("odd");
  });
});
