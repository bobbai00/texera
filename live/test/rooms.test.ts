import { afterEach, describe, expect, test } from "bun:test";
import { Forbidden } from "@hocuspocus/common";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { WorkflowSpec } from "@texera/catalog-client/types";
import { COLUMN } from "@texera/workflow-model";
import {
  applySpec,
  movePositions,
  positionsOf,
  readSaveAnswer,
  type SaveAnswer,
  saveRequest,
  specOf,
  standingIn,
} from "@texera/workflow-model/live";
import * as Y from "yjs";
import { ALICE, BOB, CAROL, DATASET, fakeCatalog, liveService, pause, until, WORKFLOW } from "./helpers.ts";

const scan = {
  operatorID: "scan",
  operatorType: "CSVFileScan",
  operatorProperties: { fileName: "texera://datasets/d@1/files/iris.csv" },
};
const avg = { operatorID: "avg", operatorType: "Aggregate", operatorProperties: { groupByKeys: ["Species"] } };
const link = {
  linkID: "l1",
  source: { operatorID: "scan", portID: "output-0" },
  target: { operatorID: "avg", portID: "input-0" },
};
const v1: WorkflowSpec = { operators: [scan, avg], links: [link] };
const limit = { operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 2 } };

/** A person changes the workflow on their screen: the document takes the difference. */
const edit = (who: HocuspocusProvider, change: (spec: WorkflowSpec) => void) => {
  const next = structuredClone(specOf(who.document));
  change(next);
  applySpec(who.document, next);
};
/** An operator of a spec, by its id: where it stands in the list says nothing. */
const op = <T>(spec: WorkflowSpec, id: string) => spec.operators.find((o) => o.operatorID === id) as unknown as T;
const operatorsOf = (who: HocuspocusProvider) =>
  specOf(who.document)
    .operators.map((o) => o.operatorID)
    .sort();
/** Who a person sees in the session, by name. */
const seenBy = (who: HocuspocusProvider) =>
  [...(who.awareness?.getStates().values() ?? [])]
    .map((s) => (s as { user?: { name: string } }).user?.name)
    .filter(Boolean)
    .sort();

/** The answers one person gets to their requests to save. */
const answersTo = (who: HocuspocusProvider) => {
  const answers: SaveAnswer[] = [];
  who.on("stateless", ({ payload }: { payload: string }) => {
    const answer = readSaveAnswer(payload);
    if (answer) answers.push(answer);
  });
  return answers;
};
/** How the session's document stands with the catalog, as one person in it has it. */
const standingFor = (who: HocuspocusProvider) =>
  standingIn((who.awareness?.getStates().values() ?? []) as Iterable<Record<string, unknown>>);

let service: ReturnType<typeof liveService> | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
});

function start() {
  const fake = fakeCatalog();
  fake.put(WORKFLOW, "workflow", { readers: [CAROL], writers: [ALICE, BOB] }, v1);
  fake.put(DATASET, "dataset", { readers: [ALICE, BOB] });
  service = liveService(fake);
  return { fake, live: service };
}

describe("who is on a resource", () => {
  test("people on the same resource see each other, whatever its kind", async () => {
    const { live } = start();
    const alice = await live.join("alice", DATASET);
    const bob = await live.join("bob", DATASET);
    alice.setAwarenessField("user", ALICE);
    bob.setAwarenessField("user", BOB);
    await until(() => seenBy(alice).length === 2 && seenBy(bob).length === 2);
    expect(seenBy(alice)).toEqual(["Alice", "Bob"]);

    // Leaving is seen too.
    bob.destroy();
    await until(() => seenBy(alice).length === 1);
    expect(seenBy(alice)).toEqual(["Alice"]);
  });

  test("only a workflow has a document to change: elsewhere a session is presence alone", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", DATASET);
    const bob = await live.join("bob", DATASET);
    alice.document.getMap("operators").set("sneaked", "in");
    await pause(150);
    expect(bob.document.getMap("operators").size).toBe(0);
    expect(fake.kept.size).toBe(0);
  });

  test("someone who may not read the resource does not get in, and neither does a token that is nobody's", async () => {
    const { live } = start();
    expect(live.join("carol", DATASET)).rejects.toThrow("permission-denied");
    expect(live.join("mallory", WORKFLOW)).rejects.toThrow("permission-denied");
    expect(live.join("alice", "not-a-resource")).rejects.toThrow("permission-denied");
    await pause(100);
    expect(live.hocuspocus.getDocumentsCount()).toBe(0);
  });
});

describe("a workflow edited together", () => {
  test("opens with the head version, laid out once, the same for everyone who joins", async () => {
    const { live } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    expect(specOf(alice.document, v1)).toEqual(v1);
    expect(specOf(bob.document, v1)).toEqual(v1);
    expect(Object.keys(positionsOf(alice.document)).sort()).toEqual(["avg", "scan"]);
    expect(positionsOf(bob.document)).toEqual(positionsOf(alice.document));
  });

  test("two people's edits reach each other and are saved as one version that names them both", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    edit(alice, (s) => {
      op<typeof avg>(s, "avg").operatorProperties.groupByKeys = ["Species", "Id"];
    });
    edit(bob, (s) => {
      s.operators.push(limit);
    });
    await until(() => operatorsOf(alice).includes("limit") && fake.saved.length > 0);
    await until(() => fake.head(WORKFLOW).vno === fake.saved.at(-1)?.vno && operatorsOf(bob).length === 3);
    const head = fake.head(WORKFLOW);
    expect(head.spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg", "limit"]);
    expect(op<typeof avg>(head.spec, "avg").operatorProperties.groupByKeys).toEqual(["Species", "Id"]);
    expect(fake.saved.flatMap((s) => s.onBehalfOf).sort()).toEqual([ALICE.pid, BOB.pid].sort());
    // The document is kept with the version it is level with.
    await until(() => fake.kept.get(WORKFLOW)?.basedOn === head.vno);
  });

  test("moving an operator is seen by everyone and makes no version; the next version takes the place", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    movePositions(alice.document, { avg: { x: 640, y: 80 } });
    await until(() => positionsOf(bob.document).avg?.x === 640);
    await until(() => fake.kept.has(WORKFLOW));
    expect(fake.saved).toEqual([]);
    expect(fake.head(WORKFLOW).vno).toBe(1);
    // An edit makes a version, which holds where every operator sits at that moment.
    edit(bob, (s) => {
      op<{ customDisplayName?: string }>(s, "avg").customDisplayName = "mean";
    });
    await until(() => fake.saved.length === 1);
    expect(fake.saved[0]?.spec.layout?.avg).toEqual({ x: 640, y: 80 });
    expect(Object.keys(fake.saved[0]?.spec.layout ?? {}).sort()).toEqual(["avg", "scan"]);
  });

  test("a version written elsewhere keeps where the operators sit, and puts a new one beside what it reads from", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    movePositions(alice.document, { avg: { x: 640, y: 80 } });
    // The session has the move once someone else sees it.
    await until(() => positionsOf(bob.document).avg?.x === 640);
    // An agent adds a limit after avg and says nothing of where anything sits.
    const next = {
      linkID: "l2",
      source: { operatorID: "avg", portID: "output-0" },
      target: { operatorID: "limit", portID: "input-0" },
    };
    fake.write(WORKFLOW, { operators: [scan, avg, limit], links: [link, next] });
    await until(() => positionsOf(alice.document).limit !== undefined);
    expect(positionsOf(alice.document).avg).toEqual({ x: 640, y: 80 });
    expect(positionsOf(alice.document).limit).toEqual({ x: 640 + COLUMN, y: 80 });
  });

  test("someone who may only read watches the edits and cannot make one", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const carol = await live.join("carol", WORKFLOW);
    edit(carol, (s) => {
      s.operators.push(limit);
    });
    edit(alice, (s) => {
      op<typeof scan>(s, "scan").operatorProperties.fileName = "texera://datasets/d@2/files/iris.csv";
    });
    await until(() => op<typeof scan>(specOf(carol.document), "scan").operatorProperties.fileName.includes("@2"));
    await until(() => fake.saved.length === 1);
    expect(operatorsOf(alice)).toEqual(["avg", "scan"]);
    expect(fake.saved[0]?.onBehalfOf).toEqual([ALICE.pid]);
    expect(fake.head(WORKFLOW).spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg"]);
  });

  test("a version written elsewhere arrives in the open document and leaves an edit not saved yet in place", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    // Alice renames an operator; before that is saved, an agent adds a limit to the saved version.
    edit(alice, (s) => {
      op<{ customDisplayName?: string }>(s, "avg").customDisplayName = "mean";
    });
    fake.write(WORKFLOW, { operators: [scan, avg, limit], links: [link] });
    await until(() => operatorsOf(alice).includes("limit"));
    expect(op<{ customDisplayName?: string }>(specOf(alice.document), "avg").customDisplayName).toBe("mean");
    // What is saved next holds both, on top of the agent's version.
    await until(() => fake.saved.length === 1);
    expect(fake.saved[0]?.vno).toBe(3);
    expect(fake.saved[0]?.spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg", "limit"]);
    expect(op<{ customDisplayName?: string }>(fake.saved[0]?.spec as WorkflowSpec, "avg").customDisplayName).toBe(
      "mean",
    );
    expect(Object.keys(positionsOf(alice.document)).sort()).toEqual(["avg", "limit", "scan"]);
  });

  test("a version of the session's own is not taken for someone else's", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => fake.saved.length === 1);
    // A later edit, made after the save: the save's own version arriving must not undo it.
    edit(alice, (s) => {
      op<typeof limit>(s, "limit").operatorProperties.limit = 9;
    });
    await until(() => fake.saved.length === 2);
    expect(op<typeof limit>(fake.head(WORKFLOW).spec, "limit").operatorProperties.limit).toBe(9);
    expect(op<typeof limit>(specOf(alice.document), "limit").operatorProperties.limit).toBe(9);
  });

  test("the next session continues the same document, and takes in what was written while nobody was there", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    movePositions(alice.document, { scan: { x: 11, y: 22 } });
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => fake.saved.length === 1 && fake.kept.get(WORKFLOW)?.basedOn === 2);
    alice.destroy();
    await until(() => live.hocuspocus.getDocumentsCount() === 0 && fake.followers(WORKFLOW) === 0);

    // Nobody is there; an agent removes the limit and changes a property.
    const v3: WorkflowSpec = {
      operators: [scan, { ...avg, operatorProperties: { groupByKeys: ["Id"] } }],
      links: [link],
    };
    fake.write(WORKFLOW, v3);

    const bob = await live.join("bob", WORKFLOW);
    expect(specOf(bob.document, v3)).toEqual(v3);
    // The same document: the place Alice gave an operator is still its place.
    expect(positionsOf(bob.document).scan).toEqual({ x: 11, y: 22 });
    expect(Object.keys(positionsOf(bob.document)).sort()).toEqual(["avg", "scan"]);
    await pause(150);
    expect(fake.head(WORKFLOW).vno).toBe(3);
  });

  test("asked to, the session saves at once: a run or an agent must not wait for the edits to settle", async () => {
    const fake = fakeCatalog();
    fake.put(WORKFLOW, "workflow", { readers: [], writers: [ALICE] }, v1);
    // A session that would not save by itself for a minute.
    service = liveService(fake, { saveAfter: 60_000 });
    const alice = await service.join("alice", WORKFLOW);
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => !alice.hasUnsyncedChanges);
    const answers = answersTo(alice);
    alice.sendStateless(saveRequest("r1"));
    await until(() => answers.length > 0);
    // The answer names the request and the version the catalog now has, so a run can be of exactly that one.
    expect(answers).toEqual([{ id: "r1", vno: 2 }]);
    expect(fake.saved.map((s) => s.vno)).toEqual([2]);
    expect(fake.head(WORKFLOW).spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg", "limit"]);
  });

  test("someone whose access is taken away stops editing, or is gone, at the next check", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    bob.setAwarenessField("user", BOB);
    await until(() => seenBy(alice).includes("Bob"));

    fake.revoke(WORKFLOW, BOB, "write");
    await live.rules.recheck(live.hocuspocus);
    edit(bob, (s) => {
      s.operators.push(limit);
    });
    await pause(150);
    expect(operatorsOf(alice)).toEqual(["avg", "scan"]);
    expect(fake.saved).toEqual([]);

    // Without the right to read he is let go, and told why in the protocol's own word.
    const closed: string[] = [];
    bob.on("close", ({ event }: { event: { reason: string } }) => closed.push(event.reason));
    fake.revoke(WORKFLOW, BOB, "read");
    await live.rules.recheck(live.hocuspocus);
    await until(() => !seenBy(alice).includes("Bob"));
    await until(() => closed.length > 0);
    expect(closed).toEqual([Forbidden.reason]);
  });

  test("how the document stands with the catalog is known to everyone in the session, whenever they joined", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    const bob = await live.join("bob", WORKFLOW);
    await until(() => standingFor(alice) !== undefined && standingFor(bob) !== undefined);
    expect(standingFor(bob)).toEqual({ vno: 1 });
    const why = "texera://datasets/d@9/files/x.csv does not exist";

    // A version the catalog does not take: both are told why, and the edit stays where it is.
    fake.refuse(WORKFLOW, why);
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => standingFor(alice)?.refused !== undefined && standingFor(bob)?.refused !== undefined);
    expect(standingFor(alice)).toEqual({ vno: 1, refused: why });
    expect(standingFor(bob)).toEqual({ vno: 1, refused: why });
    expect(fake.saved).toEqual([]);
    expect(operatorsOf(bob)).toEqual(["avg", "limit", "scan"]);
    // Asked to save now, the session answers the same: a run does not start on what is not saved.
    const answers = answersTo(alice);
    alice.sendStateless(saveRequest("r1"));
    await until(() => answers.length > 0);
    expect(answers).toEqual([{ id: "r1", refused: why }]);
    // Someone who joins while that stands has it too.
    const carol = await live.join("carol", WORKFLOW);
    await until(() => standingFor(carol) !== undefined);
    expect(standingFor(carol)).toEqual({ vno: 1, refused: why });

    // The catalog takes it again: the next save holds the edit, and everyone knows.
    fake.refuse(WORKFLOW, undefined);
    alice.sendStateless(saveRequest("r2"));
    await until(() => answers.length > 1);
    expect(answers[1]).toEqual({ id: "r2", vno: 2 });
    await until(() => standingFor(bob)?.vno === 2 && standingFor(carol)?.vno === 2);
    expect(standingFor(carol)).toEqual({ vno: 2 });
    expect(fake.head(WORKFLOW).spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg", "limit"]);

    // A version written elsewhere moves it too.
    fake.write(WORKFLOW, { ...fake.head(WORKFLOW).spec, operators: [scan, avg] });
    await until(() => standingFor(alice)?.vno === 3);
  });

  test("a document the catalog does not have is not let go when everyone leaves, and is saved when the catalog takes it", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    fake.refuse(WORKFLOW, "the catalog could not be reached");
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => !alice.hasUnsyncedChanges);
    alice.destroy();
    await pause(250);
    // Nobody is there, and the document with the edit still is.
    expect(live.hocuspocus.getDocumentsCount()).toBe(1);
    expect(fake.saved).toEqual([]);

    fake.refuse(WORKFLOW, undefined);
    await live.rules.retry(live.hocuspocus);
    expect(fake.head(WORKFLOW).spec.operators.map((o) => o.operatorID)).toEqual(["scan", "avg", "limit"]);
    expect(fake.saved.at(-1)?.onBehalfOf).toEqual([ALICE.pid]);
    // Saved, it is let go like any document nobody is on.
    await until(() => live.hocuspocus.getDocumentsCount() === 0);
  });

  test("what the spec leaves out is gone from the document the session keeps", async () => {
    const { live, fake } = start();
    const alice = await live.join("alice", WORKFLOW);
    // A link to an operator that is not there: what two people leave by removing and connecting at once.
    alice.document.getMap("links").set("loose", {
      source: { operatorID: "gone", portID: "output-0" },
      target: { operatorID: "avg", portID: "input-0" },
    });
    edit(alice, (s) => {
      s.operators.push(limit);
    });
    await until(() => fake.saved.length === 1 && fake.kept.has(WORKFLOW));
    await until(() => !alice.document.getMap("links").has("loose"));
    const kept = new Y.Doc();
    Y.applyUpdate(kept, fake.kept.get(WORKFLOW)?.state as Uint8Array);
    expect([...kept.getMap("links").keys()]).toEqual(["l1"]);
    expect(fake.saved[0]?.spec.links.map((l) => l.linkID)).toEqual(["l1"]);
  });
});
