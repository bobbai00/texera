# Texera 2.0 live service

The sessions in which people are on a resource together. One session per resource, named by
its rid, over a WebSocket behind the gateway at `/live/sessions`. It is
[Hocuspocus](https://github.com/ueberdosis/hocuspocus) (MIT) on Bun: the Yjs sync and awareness
protocols, with the rules below in one extension (`src/rooms.ts`). The catalog stays the
authority: it says who a token is and what they may do, it holds the versions, and it keeps a
session's document between sessions. The service holds nothing of its own.

## What a session is

- **Who is here.** Whoever may read a resource may join its session, whatever its kind, and
  says who they are in the session's awareness state (`user: {pid, name}`). That is all a
  session is for most kinds: the icons at the top right of a page.
- **A workflow's document.** A workflow's session also holds the document the people who may
  change the workflow edit at once (`@texera/workflow-model/live`): operators and links are
  maps keyed by id, an operator's properties a map of their own, so two people changing
  different properties of one operator both keep their change; where the operators sit is in
  the document too, one layout for everyone. Someone who may only read gets a read-only
  connection. The people in a session also say where they point and what they hold (the
  operator or box they are on), in its awareness, which is never saved. The app, not this
  service, keeps others from changing what someone holds.

## The rules of a workflow's document

The catalog's versions are the truth and the document is a working copy of them.

1. **It is loaded here, never by a browser**: from the document kept at the end of the last
   session (`GET /resources/{rid}/live`), with the change any version written since then made,
   or from the head version the first time.
2. **It is saved here, by one writer**: a moment after the edits stop
   (`TEXERA_LIVE_SAVE_AFTER_MS`, at the latest `TEXERA_LIVE_SAVE_WITHIN_MS` into a burst), as a
   new version through `POST /workflows/{rid}/edit` with `expectedHead` and `onBehalfOf`: the
   people whose edits it holds, the first recorded as its creator, all of them as its
   contributors. Then the document itself is kept (`PUT /resources/{rid}/live`). A version is
   made when what runs changes, and holds where every operator sits at that moment
   (`spec.layout`); moving an operator alone makes no version, and the move is kept with the
   document until the next one. Before a save, what the spec leaves out is taken out of the
   document (a link whose operator is gone).
3. **A version written elsewhere is taken in**: the service follows the workflow's event
   stream, and applies the change a new head made onto the open document, so the people in the
   session see an agent's edit arrive and keep the edits they have not saved yet. A place the
   version moved is put on the canvas; an operator it gives no place keeps the one it has, and
   one that has none goes beside what it connects to. A save that finds the head moved (409)
   takes the head in and saves on top of it.
4. **Everyone knows how the document stands with the catalog**: the session's own awareness
   state holds it (`catalog: {vno, refused?}`), so it reaches whoever joins, whenever. A
   version the catalog does not take (a file that does not exist, the catalog being away)
   leaves the edits in the document and says why. Such a document is not let go when the last
   person leaves, and the save is tried again every `TEXERA_LIVE_RECHECK_MS`. A workflow that
   is gone (the catalog answers 404, and the service sees every resource) has nothing left to
   save to: its document is let go with what it holds, and not tried again.
5. **A save can be asked for**: `save:<id>` as a stateless message, answered to the asker with
   `saved:<id>:<vno>` or `not-saved:<id>:<reason>`. A run, and an agent asked about the
   workflow, read the catalog's version, so the app asks first.
6. **Access is asked again** every `TEXERA_LIVE_RECHECK_MS`: someone who may no longer
   write becomes read-only, someone who may no longer read is let go with the protocol's
   `Forbidden` reason, and the app then asks the catalog and shows its answer.

## Run

```
cd live
bun run dev          # ws://localhost:23003/live/sessions, behind the gateway at /live/
bun test             # the rules against a catalog held in memory, joined as a browser joins
bun run typecheck
bun run lint
```

The token goes in the protocol's first message (a browser cannot set a header on a WebSocket),
so the gateway routes `/live/` without its own check and the service asks the catalog: `GET
/me` and `GET /resources/{rid}` as the person, `POST /access/v1/evaluation` for `write`.
Loading and saving go with the service's own token (`texera-services`).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TEXERA_LIVE_PORT` | `23003` | listen port |
| `TEXERA_CATALOG_URL` | `http://localhost:8088` | base URL for catalog calls |
| `TEXERA_OIDC_TOKEN_URL` | `http://localhost:8088/auth/realms/texera/protocol/openid-connect/token` | client-credentials endpoint |
| `TEXERA_SERVICE_CLIENT_ID` / `_SECRET` | `texera-services` / `texera-services-secret` | the service's own identity |
| `TEXERA_LIVE_SAVE_AFTER_MS` | `1500` | how long after the last edit a version is saved |
| `TEXERA_LIVE_SAVE_WITHIN_MS` | `8000` | the longest a burst of edits goes unsaved |
| `TEXERA_LIVE_RECHECK_MS` | `30000` | how often access is asked again and a refused save retried |

## Layout

```
src/config.ts     environment → config
src/catalog.ts    what the service asks of the catalog, over HTTP
src/rooms.ts      the rules of a session
src/server.ts     Bun's WebSocket server handing connections to Hocuspocus
src/main.ts       wiring
test/             bun tests: the real rules and server on a free port, a catalog in memory
```

## Limits

- One instance: the sessions are in its memory. More copies need Hocuspocus's Redis
  extension, so that everyone on a resource reaches the same document.
- A document the catalog has not taken is held in memory until it is; a restart of the
  service in that state loses those edits.
- Text is not merged inside a value: two people typing in one property at once, the code of a
  Python operator included, is last write wins for that property.
