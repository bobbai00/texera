// A person's preferences: the project they work in, the chat they last used beside each page.
// The catalog keeps them as one object and replaces it whole, so every change goes through
// one writer: it reads what the catalog has now, changes that, and writes it back, one change
// at a time. Two changes made back to back, or one made in another tab, are never lost.
//
// The writer also decides what the app shows meanwhile: what the catalog holds as far as it
// knows, with every change still on its way. A change is on screen at once and stays there
// while it is written; one the catalog did not take goes from the screen again.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { meGet, meUpdatePreferences } from "@texera/catalog-client";
import type { Me } from "@texera/catalog-client/types";
import { unwrap } from "./api";
import { meQuery } from "./queries";

export type Preferences = Record<string, unknown>;
export type PreferenceChange = (preferences: Preferences) => Preferences;

/** Where preferences are kept, and where the app shows them. */
export interface PreferenceStore {
  /** What the catalog holds now. */
  read: () => Promise<Preferences>;
  write: (preferences: Preferences) => Promise<void>;
  /** What the app shows now. */
  shown: () => Preferences;
  show: (preferences: Preferences) => void;
}

/**
 * One writer over a store: changes are applied in the order they were asked for, each to what
 * the store holds then. The promise it returns rejects when the store did not take the change.
 */
export function preferencesWriter(store: PreferenceStore): (change: PreferenceChange) => Promise<void> {
  /** Asked for and not written yet, in order. */
  const waiting: PreferenceChange[] = [];
  /** What the catalog holds, as far as the app knows. */
  let held: Preferences = {};
  let last: Promise<unknown> = Promise.resolve();
  const show = () => store.show(waiting.reduce((preferences, change) => change(preferences), held));
  return change => {
    // With nothing on its way, what the app shows is what the catalog held when it was read.
    if (waiting.length === 0) held = store.shown();
    waiting.push(change);
    show();
    const run = async () => {
      try {
        held = await store.read();
        const next = change(held);
        await store.write(next);
        held = next;
      } finally {
        waiting.splice(waiting.indexOf(change), 1);
        show();
      }
    };
    const done = last.then(run, run);
    last = done.catch(() => undefined);
    return done;
  };
}

const writers = new WeakMap<QueryClient, (change: PreferenceChange) => Promise<void>>();

/** Changes the person's preferences: the app shows the change at once, the catalog keeps it. */
export function useChangePreferences(): (change: PreferenceChange) => Promise<void> {
  const queryClient = useQueryClient();
  let writer = writers.get(queryClient);
  if (!writer) {
    const key = meQuery().queryKey;
    writer = preferencesWriter({
      // Asked of the catalog itself: what the app shows stays as the writer put it.
      read: async () => (await unwrap(meGet())).preferences,
      write: async preferences => {
        await unwrap(meUpdatePreferences({ body: preferences }));
      },
      shown: () => queryClient.getQueryData<Me>(key)?.preferences ?? {},
      show: preferences => queryClient.setQueryData(key, (me: Me | undefined) => (me ? { ...me, preferences } : me)),
    });
    writers.set(queryClient, writer);
  }
  return writer;
}
