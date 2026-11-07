import { describe, expect, it } from "vitest";
import { placeOf } from "./warehouse";

describe("where a warehouse keeps its tables, in a few words", () => {
  it("is the deployment's store when it names none of its own", () => {
    expect(placeOf({})).toBe("on the deployment's store");
  });

  it("is the bucket, the folder and the store's address when it names its own", () => {
    const storage = { endpoint: "https://store.example.org", region: "us-east-1", bucket: "lab", credential: "texera://credentials/1" };
    expect(placeOf({ storage })).toBe("lab on store.example.org");
    expect(placeOf({ storage: { ...storage, keyPrefix: "/results/" } })).toBe("lab/results on store.example.org");
  });
});
