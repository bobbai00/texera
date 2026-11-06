import { describe, expect, it } from "vitest";
import { type Preferences, preferencesWriter } from "./preferences";

/** A person's preferences as the catalog keeps them, slow to answer like a network, and what the app shows of them. */
function catalog(start: Preferences) {
  let kept = start;
  // Everything the app has shown, in order: the first is what it had loaded.
  const shown: Preferences[] = [start];
  const wait = () => new Promise(resolve => setTimeout(resolve, 5));
  return {
    kept: () => kept,
    shown,
    /** As another tab would: a write the app here never saw. */
    elsewhere: (p: Preferences) => {
      kept = p;
    },
    store: {
      read: async () => {
        await wait();
        return kept;
      },
      write: async (p: Preferences) => {
        await wait();
        kept = p;
      },
      shown: () => shown.at(-1) as Preferences,
      show: (p: Preferences) => {
        shown.push(p);
      },
    },
  };
}

describe("the one writer of a person's preferences", () => {
  it("applies changes made back to back one after the other, so neither is lost", async () => {
    const c = catalog({});
    const change = preferencesWriter(c.store);
    await Promise.all([change(p => ({ ...p, project: "lab" })), change(p => ({ ...p, dock: { page: "chat" } }))]);
    expect(c.kept()).toEqual({ project: "lab", dock: { page: "chat" } });
  });

  it("changes what the catalog has now, not what the app read a while ago", async () => {
    const c = catalog({ project: "lab" });
    const change = preferencesWriter(c.store);
    c.elsewhere({ project: "lab", dock: { page: "chat" } });
    await change(p => ({ ...p, project: "field" }));
    expect(c.kept()).toEqual({ project: "field", dock: { page: "chat" } });
    expect(c.shown.at(-1)).toEqual(c.kept());
  });

  it("shows a change at once, and never again what there was before it", async () => {
    const c = catalog({ project: "lab" });
    const change = preferencesWriter(c.store);
    const done = change(p => ({ ...p, project: "field" }));
    // Before the catalog has answered anything.
    expect(c.shown.at(-1)).toEqual({ project: "field" });
    await done;
    // What the catalog held is read on the way, and is not put on screen by itself: a page that
    // follows the pick would go back and forth.
    expect(c.shown.slice(1).map(p => p.project)).not.toContain("lab");
  });

  it("keeps a later change on screen while an earlier one is written", async () => {
    const c = catalog({});
    const change = preferencesWriter(c.store);
    const first = change(p => ({ ...p, project: "lab" }));
    const second = change(p => ({ ...p, dock: { page: "chat" } }));
    const from = c.shown.length - 1;
    await Promise.all([first, second]);
    for (const p of c.shown.slice(from)) expect(p).toEqual({ project: "lab", dock: { page: "chat" } });
  });

  it("takes a change the catalog refused off the screen, and keeps going", async () => {
    const c = catalog({ project: "lab" });
    let fail = true;
    const change = preferencesWriter({
      ...c.store,
      write: async p => {
        if (fail) throw new Error("offline");
        await c.store.write(p);
      },
    });
    await expect(change(p => ({ ...p, project: "field" }))).rejects.toThrow("offline");
    expect(c.shown.at(-1)).toEqual({ project: "lab" });
    fail = false;
    await change(p => ({ ...p, project: "field" }));
    expect(c.kept()).toEqual({ project: "field" });
    expect(c.shown.at(-1)).toEqual({ project: "field" });
  });

  it("shows what it last knew of the catalog when the catalog cannot be read", async () => {
    const c = catalog({ project: "lab" });
    const change = preferencesWriter({
      ...c.store,
      read: async () => {
        throw new Error("offline");
      },
    });
    await expect(change(p => ({ ...p, project: "field" }))).rejects.toThrow("offline");
    expect(c.shown.at(-1)).toEqual({ project: "lab" });
  });
});
