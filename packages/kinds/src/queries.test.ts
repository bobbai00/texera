import { describe, expect, it } from "vitest";
import { isAbout } from "./queries";

const RID = "0b7a1c2d-0000-4000-8000-00000000000a";
const OTHER = "0b7a1c2d-0000-4000-8000-00000000000b";

describe("what the app read about a resource", () => {
  it("is its envelope, whatever of it was read by its rid, and what the person may do with it", () => {
    for (const key of [
      ["resource", RID],
      [{ _id: "workflowsRead", path: { rid: RID } }],
      [{ _id: "conversationsListMessages", path: { rid: RID }, query: { limit: 500 } }],
      [{ _id: "resourcesListGrants", path: { rid: RID } }],
      ["can", "write", RID],
    ]) {
      expect(isAbout(key, RID), JSON.stringify(key)).toBe(true);
      expect(isAbout(key, OTHER), JSON.stringify(key)).toBe(false);
    }
  });

  it("is not a list it may be in, or something read by a name", () => {
    for (const key of [[{ _id: "resourcesSearch", query: { kind: "workflow" } }], ["resolve", `texera://workflows/${RID}`], ["operator-schemas", null], []]) {
      expect(isAbout(key, RID), JSON.stringify(key)).toBe(false);
    }
  });
});
