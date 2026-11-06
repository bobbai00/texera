import { describe, expect, it } from "vitest";
import { arrivedFrom } from "./arrivals";

describe("operators that arrive on a canvas from elsewhere", () => {
  it("are the ones the canvas had not seen and did not add itself", () => {
    expect(arrivedFrom(new Set(["scan", "avg"]), ["scan", "avg", "limit", "mine"], new Set(["mine"]))).toEqual([
      "limit",
    ]);
  });

  it("are none while nothing new came", () => {
    expect(arrivedFrom(new Set(["scan", "avg"]), ["avg"], new Set())).toEqual([]);
  });
});
