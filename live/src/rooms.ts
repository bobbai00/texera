/**
 * The rules of a live session: the people who are on one resource at the same moment.
 *
 * A session is named by the resource's rid. Whoever may read the resource may join, and sees
 * who else is there; that is all a session is for most kinds. A workflow has a document as
 * well, which the people who may change the workflow edit at once.
 *
 * The catalog's versions stay the truth, and the document is a working copy of them:
 *  - It is loaded here, never by a browser: from the document kept at the end of the last
 *    session, or from the head version the first time.
 *  - It is saved here, by one writer: a moment after the edits stop, as a new version that
 *    names the people whose edits it holds.
 *  - A version written elsewhere (by an agent, through the API) is taken into the open
 *    document as the change it made, so the people in the session see it arrive and keep the
 *    edits they have not saved yet.
 *  - How the document stands with the catalog is part of the session's own awareness state,
 *    so everyone in it knows, whenever they joined: the version it was last saved as, and why
 *    the last save was not taken. A document the catalog does not have is not let go when the
 *    last person leaves; the save is tried again until the catalog takes it.
 */
import { Forbidden } from "@hocuspocus/common";
import type { Connection, Document, Extension, Hocuspocus } from "@hocuspocus/server";
import { isTransactionOrigin } from "@hocuspocus/server";
import type { WorkflowSpec } from "@texera/catalog-client/types";
import {
  applyChange,
  applySpec,
  dropLeftovers,
  placeOperators,
  readSaveRequest,
  STANDING,
  type Standing,
  same,
  saveAnswer,
  specOf,
} from "@texera/workflow-model/live";
import * as Y from "yjs";
import { type Catalog, CatalogError, type Head } from "./catalog.ts";
import type { Logger } from "./log.ts";

/** Who is on a connection, and the kind of resource the session is of. */
export interface Member {
  pid: string;
  name: string;
  kind: string;
}

const WORKFLOW = "workflow";
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY: WorkflowSpec = { operators: [], links: [] };
/** A change the service makes itself: a version taken in, the layout. It is saved like any other. */
const OURS = { source: "local" as const };
/** How often a save is tried again after the head moved under it. */
const SAVE_TRIES = 3;

/** The open document of one workflow, against the catalog. */
interface Session {
  /** The version the document was last level with, and its spec. */
  base: number;
  saved: WorkflowSpec;
  /** Whose edits the document holds beyond that version. */
  contributors: Set<string>;
  /** Ends the following of the workflow's versions. */
  stop: AbortController;
  /** Why the catalog took no version at the last save, while that stands. */
  refused?: string;
  /** Lets the document go if nobody is on it and the catalog has it; otherwise does nothing. */
  letGo: () => void;
}

export interface Rooms extends Extension<Member> {
  /** Asks the catalog again about everyone connected: access taken away ends or narrows a session. */
  recheck(instance: Hocuspocus<Member>): Promise<void>;
  /** Tries again to save what the catalog did not take. */
  retry(instance: Hocuspocus<Member>): Promise<void>;
}

/** Why a save did not happen, as the people in the session read it. */
const reasonOf = (err: unknown) => (err instanceof CatalogError ? err.message : "the catalog could not be reached");

export function rooms({ catalog, log }: { catalog: Catalog; log: Logger }): Rooms {
  const sessions = new Map<string, Session>();

  /** Says in the session's own awareness state how the document stands with the catalog. */
  const tell = (document: Document, session: Session) => {
    const standing: Standing = {
      vno: session.base,
      ...(session.refused !== undefined ? { refused: session.refused } : {}),
    };
    if (!same(document.awareness.getLocalState()?.[STANDING], standing)) {
      document.awareness.setLocalState({ [STANDING]: standing });
    }
  };

  /** Brings the document level with a head written elsewhere: the change it made, on top of what is here. */
  const takeIn = (document: Document, session: Session, head: Head) => {
    if (head.vno <= session.base) return;
    applyChange(document, session.saved, head.spec, OURS);
    placeOperators(document, OURS);
    session.base = head.vno;
    session.saved = head.spec;
    tell(document, session);
  };

  /** Saves what the document holds beyond its version, then keeps the document itself. */
  const save = async (document: Document, rid: string, session: Session) => {
    dropLeftovers(document, OURS);
    for (let attempt = 1; ; attempt++) {
      const spec = specOf(document, session.saved);
      if (same(spec, session.saved)) break;
      // Edits that arrive while the save is under way belong to the next version.
      const authors = session.contributors;
      session.contributors = new Set();
      try {
        session.base = await catalog.save(rid, spec, session.base, [...authors]);
        session.saved = spec;
        log.info("version saved", { rid, vno: session.base, by: [...authors] });
        break;
      } catch (err) {
        for (const pid of authors) session.contributors.add(pid);
        if (!(err instanceof CatalogError && err.status === 409) || attempt >= SAVE_TRIES) throw err;
        // Someone wrote a version in the meantime: take it in and save on top of it.
        takeIn(document, session, await catalog.head(rid));
      }
    }
    await catalog.keep(rid, { basedOn: session.base, state: Y.encodeStateAsUpdate(document) });
  };

  /**
   * Saves, and says how the document then stands with the catalog; whoever asked for the save
   * gets the answer to their request. Whoever calls holds the document's save lock. Returns
   * whether the catalog has the document.
   */
  const store = async (document: Document, rid: string, session: Session, asked?: { id: string; by: Connection }) => {
    try {
      await save(document, rid, session);
      session.refused = undefined;
    } catch (err) {
      session.refused = reasonOf(err);
      log.warn("not saved", { rid, reason: session.refused });
    }
    tell(document, session);
    if (asked) {
      const { id, by } = asked;
      by.sendStateless(
        saveAnswer(session.refused === undefined ? { id, vno: session.base } : { id, refused: session.refused }),
      );
    }
    return session.refused === undefined;
  };

  /**
   * Works on the document under its save lock, so a version of the session's own is never
   * taken for someone else's. The lock keeps a document from being let go; once the work is
   * done a document nobody is on any more gets that chance again.
   */
  const alone = async <T>(document: Document, session: Session, work: () => T | Promise<T>): Promise<T> => {
    try {
      return await document.saveMutex.runExclusive(work);
    } finally {
      session.letGo();
    }
  };

  return {
    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (!RID.test(documentName)) throw new Error("a session is named by a resource's rid");
      const [person, kind] = await Promise.all([catalog.person(token), catalog.kindOf(documentName, token)]);
      // Only a workflow has a document to change; elsewhere a session is who is there.
      connectionConfig.readOnly = !(kind === WORKFLOW && (await catalog.mayWrite(documentName, token)));
      return { ...person, kind } satisfies Member;
    },

    async onLoadDocument({ document, documentName, context, instance }) {
      if (context.kind !== WORKFLOW) return;
      const [kept, head] = await Promise.all([catalog.kept(documentName), catalog.head(documentName)]);
      if (kept) {
        Y.applyUpdate(document, kept.state);
        // A version written while nobody was here: the change it made since the document was kept.
        if (kept.basedOn !== head.vno) {
          applyChange(document, kept.basedOn ? await catalog.version(documentName, kept.basedOn) : EMPTY, head.spec);
        }
      } else {
        applySpec(document, head.spec);
      }
      placeOperators(document);
      const session: Session = {
        base: head.vno,
        saved: head.spec,
        contributors: new Set(),
        stop: new AbortController(),
        letGo: () => void instance.unloadDocument(document).catch(() => undefined),
      };
      sessions.set(documentName, session);
      tell(document, session);
      catalog.follow(
        documentName,
        {
          head: (next) => void alone(document, session, () => takeIn(document, session, next)),
          gone: () => instance.closeConnections(documentName),
        },
        session.stop.signal,
      );
    },

    async onChange({ documentName, transactionOrigin }) {
      if (isTransactionOrigin(transactionOrigin) && transactionOrigin.source === "connection") {
        sessions.get(documentName)?.contributors.add((transactionOrigin.connection.context as Member).pid);
      }
    },

    // Called under the document's save lock, a moment after the edits stop.
    async onStoreDocument({ document, documentName }) {
      const session = sessions.get(documentName);
      if (session) await store(document, documentName, session);
    },

    // A run, or an agent asked about the workflow, reads the catalog's version: whoever starts
    // one asks for the session to be saved first, rather than waiting for the edits to settle.
    async onStateless({ payload, document, documentName, connection }) {
      const id = readSaveRequest(payload);
      if (id === undefined) return;
      const session = sessions.get(documentName);
      // Only a workflow has something to save; elsewhere nothing waits.
      if (!session) connection.sendStateless(saveAnswer({ id }));
      else await alone(document, session, () => store(document, documentName, session, { id, by: connection }));
    },

    // A document is let go only when the catalog has what it holds: one more try, and it stays
    // if that fails, for whoever comes back and for the next retry.
    async beforeUnloadDocument({ document, documentName }) {
      const session = sessions.get(documentName);
      if (!session || same(specOf(document, session.saved), session.saved)) return;
      if (!(await document.saveMutex.runExclusive(() => store(document, documentName, session)))) {
        throw new Error(`${documentName} is not saved: ${session.refused}`);
      }
    },

    async afterUnloadDocument({ documentName }) {
      sessions.get(documentName)?.stop.abort();
      sessions.delete(documentName);
    },

    async recheck(instance) {
      for (const [rid, document] of instance.documents) {
        for (const connection of document.connections.keys()) {
          const { pid, kind } = connection.context as Member;
          try {
            // Let go with the protocol's own word for it, so the page knows to ask the catalog why.
            if (!(await catalog.stillMay(pid, "read", rid))) connection.close(Forbidden);
            else if (kind === WORKFLOW) connection.readOnly = !(await catalog.stillMay(pid, "write", rid));
          } catch (err) {
            log.warn("could not ask the catalog about someone connected", { rid, pid, error: (err as Error).message });
          }
        }
      }
    },

    async retry(instance) {
      for (const [rid, document] of instance.documents) {
        const session = sessions.get(rid);
        if (session?.refused !== undefined) await alone(document, session, () => store(document, rid, session));
      }
    },
  };
}
