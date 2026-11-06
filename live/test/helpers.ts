/**
 * A live service for a test: the real rules and server on a free port, against a catalog held
 * in memory, with people who join as a browser does.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Hocuspocus } from "@hocuspocus/server";
import type { WorkflowSpec } from "@texera/catalog-client/types";
import { type Catalog, CatalogError, type Head, type Kept, type Person } from "../src/catalog.ts";
import { createLogger } from "../src/log.ts";
import { type Member, rooms } from "../src/rooms.ts";
import { serve } from "../src/server.ts";

export const ALICE: Person = { pid: "a11ce000-0000-4000-8000-000000000001", name: "Alice" };
export const BOB: Person = { pid: "b0b00000-0000-4000-8000-000000000002", name: "Bob" };
export const CAROL: Person = { pid: "ca401000-0000-4000-8000-000000000003", name: "Carol" };
/** A person's token is their first name, lower case. */
const PEOPLE = new Map([ALICE, BOB, CAROL].map((p) => [p.name.toLowerCase(), p]));

export const WORKFLOW = "30000000-0000-4000-8000-000000000001";
export const DATASET = "40000000-0000-4000-8000-000000000002";

interface Held {
  kind: string;
  readers: Set<string>;
  writers: Set<string>;
  versions: WorkflowSpec[];
}

export interface Saved {
  rid: string;
  vno: number;
  spec: WorkflowSpec;
  onBehalfOf: string[];
}

/** The catalog, in memory: resources with who may read and write them, versions, kept documents. */
export function fakeCatalog() {
  const held = new Map<string, Held>();
  const kept = new Map<string, Kept>();
  const followers = new Map<string, Set<{ head: (head: Head) => void; gone: () => void }>>();
  const saved: Saved[] = [];
  /** Why the catalog takes no version of a resource right now. */
  const refusing = new Map<string, string>();
  const of = (rid: string) => {
    const r = held.get(rid);
    if (!r) throw new CatalogError(404, "not found");
    return r;
  };
  const headOf = (rid: string): Head => ({
    vno: of(rid).versions.length,
    spec: of(rid).versions.at(-1) as WorkflowSpec,
  });
  const tell = (rid: string) => {
    for (const f of followers.get(rid) ?? []) f.head(headOf(rid));
  };
  const who = (token: string) => {
    const person = PEOPLE.get(token);
    if (!person) throw new CatalogError(401, "nobody");
    return person;
  };

  const catalog: Catalog = {
    person: async (token) => who(token),
    async kindOf(rid, token) {
      if (!of(rid).readers.has(who(token).pid)) throw new CatalogError(403, "forbidden");
      return of(rid).kind;
    },
    mayWrite: async (rid, token) => of(rid).writers.has(who(token).pid),
    stillMay: async (pid, action, rid) => (action === "read" ? of(rid).readers : of(rid).writers).has(pid),
    head: async (rid) => headOf(rid),
    version: async (rid, vno) => of(rid).versions[vno - 1] as WorkflowSpec,
    kept: async (rid) => kept.get(rid),
    async keep(rid, document) {
      kept.set(rid, document);
    },
    async save(rid, spec, expectedHead, onBehalfOf) {
      const reason = refusing.get(rid);
      if (reason) throw new CatalogError(400, reason);
      if (expectedHead !== of(rid).versions.length) throw new CatalogError(409, "the head moved");
      of(rid).versions.push(structuredClone(spec));
      const vno = of(rid).versions.length;
      saved.push({ rid, vno, spec: structuredClone(spec), onBehalfOf });
      tell(rid);
      return vno;
    },
    follow(rid, on, signal) {
      const set = followers.get(rid) ?? new Set();
      followers.set(rid, set);
      set.add(on);
      signal.addEventListener("abort", () => set.delete(on));
    },
  };

  return {
    catalog,
    /** What the live service saved, in order. */
    saved,
    kept,
    /** Puts a resource in the catalog; people read and write it as told. */
    put(rid: string, kind: string, access: { readers: Person[]; writers?: Person[] }, spec?: WorkflowSpec) {
      const writers = access.writers ?? [];
      held.set(rid, {
        kind,
        readers: new Set([...access.readers, ...writers].map((p) => p.pid)),
        writers: new Set(writers.map((p) => p.pid)),
        versions: spec ? [spec] : [],
      });
    },
    /** A version written by someone outside the session: an agent, the API. */
    write(rid: string, spec: WorkflowSpec) {
      of(rid).versions.push(structuredClone(spec));
      tell(rid);
      return of(rid).versions.length;
    },
    head: headOf,
    /** Takes someone's access away. */
    revoke(rid: string, person: Person, what: "read" | "write") {
      of(rid).writers.delete(person.pid);
      if (what === "read") of(rid).readers.delete(person.pid);
    },
    followers: (rid: string) => followers.get(rid)?.size ?? 0,
    /** Makes the catalog take no version of a resource, for a reason; undefined lets it again. */
    refuse(rid: string, reason: string | undefined) {
      if (reason) refusing.set(rid, reason);
      else refusing.delete(rid);
    },
  };
}

/** The live service on a free port, and a way to join it as a browser does. */
export function liveService(fake: ReturnType<typeof fakeCatalog>, { saveAfter = 40 }: { saveAfter?: number } = {}) {
  const lines: string[] = [];
  const rules = rooms({ catalog: fake.catalog, log: createLogger((line) => lines.push(line)) });
  const hocuspocus = new Hocuspocus<Member>({
    extensions: [rules],
    debounce: saveAfter,
    maxDebounce: saveAfter * 5,
    quiet: true,
  });
  const server = serve(hocuspocus, 0);
  const joined: HocuspocusProvider[] = [];

  /** Joins a resource's session; rejects when the catalog says no. */
  const join = (token: string, rid: string) =>
    new Promise<HocuspocusProvider>((resolve, reject) => {
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${server.port}/live/sessions`,
        name: rid,
        token,
        onSynced: () => resolve(provider),
        onAuthenticationFailed: ({ reason }) => reject(new Error(reason)),
      });
      joined.push(provider);
    });

  return {
    join,
    rules,
    hocuspocus,
    lines,
    async stop() {
      for (const p of joined) p.destroy();
      await until(() => hocuspocus.getDocumentsCount() === 0, 3000).catch(() => undefined);
      await server.stop(true);
    },
  };
}

/** Waits until something holds, or fails after a moment. */
export async function until(holds: () => boolean, within = 3000): Promise<void> {
  const deadline = Date.now() + within;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`not within ${within} ms: ${holds.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
