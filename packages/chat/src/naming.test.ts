import { describe, expect, it } from "vitest";
import { chatName, createNamed } from "./naming";

const started = new Date(2026, 10, 5, 14, 20, 31);

describe("the name a chat starts with", () => {
  it("says when it started, and what it is about when it was started beside a page", () => {
    expect(chatName(undefined, started)).toBe("Chat, Nov 5, 02:20:31 PM");
    expect(chatName("iris", started)).toBe("About iris, Nov 5, 02:20:31 PM");
  });
});

describe("making something under a name that may be taken", () => {
  const taken = (names: string[]) => async (name: string) => {
    if (names.includes(name)) throw Object.assign(new Error("conflict"), { status: 409 });
    return name;
  };

  it("uses the name as it is when it is free", async () => {
    expect(await createNamed("Chat, now", taken([]))).toBe("Chat, now");
  });

  it("numbers the name when another chat of the project started in the same second", async () => {
    expect(await createNamed("Chat, now", taken(["Chat, now", "Chat, now (2)"]))).toBe("Chat, now (3)");
  });

  it("gives up on any other refusal, and on a name nothing frees", async () => {
    const refused = async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    };
    await expect(createNamed("Chat, now", refused)).rejects.toThrow("forbidden");
    const always = async () => {
      throw Object.assign(new Error("conflict"), { status: 409 });
    };
    await expect(createNamed("Chat, now", always)).rejects.toThrow("conflict");
  });
});
