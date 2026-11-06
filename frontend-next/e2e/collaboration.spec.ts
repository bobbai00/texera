import { type Browser, expect, type Page, test } from "@playwright/test";
import { aPageOfEveryKind, api, type Caller, cleanups, discard, editOperator, type Envelope, IRIS_CSV, openChat, operatorList, say, signIn, tidyUp } from "./support";

// People on the same resource: who has a page open is shown at its top right, on every kind of
// page; a workflow is edited by several people at once, each seeing the others' changes as
// they are made, and what they made together is saved as versions that name them; a chat is a
// group chat, where a person asks the agent or says something to the others, and everyone
// watches the answer arrive.

test.afterEach(tidyUp);

/** Another person's own browser, signed in. */
async function browserOf(browser: Browser, user: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user, user);
  cleanups.push(() => context.close());
  return page;
}

/** The people shown on a page, by principal id. */
const present = (page: Page) => page.locator("[data-presence] [data-present]");
const presentOn = async (page: Page) => page.locator("[data-presence] [data-present]").evaluateAll(els => els.map(el => el.getAttribute("data-present")));

const scanAndAverage = (file: string) => ({
  operators: [
    { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: file, fileEncoding: "UTF_8", hasHeader: true } },
    { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
  ],
  links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
});

/** A project of alice's with the iris flowers and a workflow over them. */
async function aWorkflow(alice: Caller, label: string) {
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `${label} ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "Fisher's iris flowers" });
  const workflow: Envelope = await alice("POST", "/workflows", { name: `${label} ${stamp}`, parent: project.metadata.rid, spec: scanAndAverage(`${dataset.metadata.uri}@1/files/iris.csv`) });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  return { project: project.metadata.rid, rid: workflow.metadata.rid };
}

/** The same, with the project shared with bob as told. */
async function sharedWorkflow(alice: Caller, bob: Caller, relation: "viewer" | "editor") {
  const made = await aWorkflow(alice, "edited together");
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  const alicePid = (await alice("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${made.project}/grants/${bobPid}`, { relation });
  return { ...made, alicePid, bobPid };
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const versionsOf = async (as: Caller, rid: string) => ((await as("GET", `/workflows/${rid}/versions`)) as { items: { vno: number; createdBy: string; contributors?: string[] }[] }).items;
const headOf = async (as: Caller, rid: string) => (await as("GET", `/workflows/${rid}`)) as { metadata: { head: number }; spec: { operators: { operatorID: string; operatorType: string; operatorProperties: Record<string, unknown> }[] } };

test("whoever has a page open is shown at its top right, on the page of every kind and in a chat", async ({ page, request }) => {
  test.setTimeout(180_000);
  const as = await api(request);
  const { pages } = await aPageOfEveryKind(as);
  const me = (await as("GET", "/me")).principal.pid as string;
  const chat: Envelope = await as("POST", "/conversations", { name: `presence ${Date.now()}`, spec: {} });
  cleanups.push(() => as.attempt("DELETE", `/resources/${chat.metadata.rid}`));

  await signIn(page);
  for (const at of [...pages.map(p => ({ kind: p.kind, path: p.path })), { kind: "conversation", path: `/conversations/${chat.metadata.rid}` }]) {
    await test.step(at.kind, async () => {
      await page.goto(at.path);
      await expect(present(page)).toHaveCount(1);
      expect(await presentOn(page)).toEqual([me]);
      // At the top right of the page's header.
      const header = page.locator("[data-resource-header], [data-chat-header]").first();
      const [box, icon] = [await header.boundingBox(), await present(page).first().boundingBox()];
      expect(icon && box && icon.x > box.x + box.width / 2 && icon.y < box.y + box.height).toBeTruthy();
    });
  }
  await page.screenshot({ path: "test-results/presence.png" });
});

test("two people on one page see each other, and see when the other leaves", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid, alicePid, bobPid } = await sharedWorkflow(alice, bob, "viewer");

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(present(page)).toHaveCount(1);
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/workflows/${rid}`);

  // Each sees both, themself first.
  await expect(present(page)).toHaveCount(2);
  await expect(present(bobs)).toHaveCount(2);
  expect(await presentOn(page)).toEqual([alicePid, bobPid]);
  expect(await presentOn(bobs)).toEqual([bobPid, alicePid]);
  await expect(present(page).nth(0)).toHaveAttribute("aria-label", "Alice Liddell (you)");
  await expect(present(page).nth(1)).toHaveAttribute("aria-label", "Bob Builder");
  await page.screenshot({ path: "test-results/presence-two.png" });

  // Bob goes to another page: alice is alone again.
  await bobs.goto("/workflows");
  await expect(present(page)).toHaveCount(1);
});

test("two people edit one workflow at the same moment, and what they made is saved in both their names", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid, alicePid, bobPid } = await sharedWorkflow(alice, bob, "editor");

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/workflows/${rid}`);
  await expect(node(page, "avg")).toBeVisible();
  await expect(node(bobs, "avg")).toBeVisible();
  await expect(bobs.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "true");

  // Alice adds an operator from the list: it appears on bob's canvas with no reload.
  const palette = await operatorList(page);
  await palette.getByPlaceholder("Search operators").fill("Limit");
  await palette.locator('[data-palette-operator="Limit"]').click();
  await expect(page.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  await expect(bobs.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  // A new operator opens in its card, to be set; alice is done with it.
  await page.locator("[data-operator-done]").click();

  // At the same moment bob changes the aggregate in its card: alice's card says so.
  await (await editOperator(bobs, "avg")).getByLabel("Operator name").fill("mean petal");
  await expect(node(page, "avg")).toContainText("mean petal");
  await bobs.locator("[data-operator-done]").click();

  // One layout for both: where alice drags an operator is where bob sees it. The two operators
  // start on one row; how far the scan sits below the average says where it was put, whatever
  // the canvas's zoom.
  const below = async (on: Page) => ((await node(on, "scan").boundingBox())?.y ?? 0) - ((await node(on, "avg").boundingBox())?.y ?? 0);
  expect(Math.abs(await below(bobs))).toBeLessThan(5);
  const grip = await node(page, "scan").boundingBox();
  await page.mouse.move((grip?.x ?? 0) + 20, (grip?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((grip?.x ?? 0) + 20, (grip?.y ?? 0) + 160, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => below(bobs)).toBeGreaterThan(40);

  // The live service saves what the two of them made: the head holds both changes, and the
  // versions name whose edits they are.
  await expect.poll(async () => (await headOf(alice, rid)).spec.operators.map(o => o.operatorType).sort(), { timeout: 20_000 }).toEqual(["Aggregate", "CSVFileScan", "Limit"]);
  const head = await headOf(alice, rid);
  expect((head.spec.operators.find(o => o.operatorID === "avg") as { customDisplayName?: string }).customDisplayName).toBe("mean petal");
  const versions = await versionsOf(alice, rid);
  const authors = new Set(versions.filter(v => v.vno > 1).flatMap(v => v.contributors ?? [v.createdBy]));
  expect([...authors].sort()).toEqual([alicePid, bobPid].sort());
  // Moving an operator made no version of its own: the last version is still a change to the spec.
  await page.waitForTimeout(2500);
  expect((await headOf(alice, rid)).metadata.head).toBe(head.metadata.head);
  await page.screenshot({ path: "test-results/edited-together.png" });

  // Someone who opens the workflow later gets the same picture: the document continues.
  await bobs.reload();
  await expect(bobs.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  await expect.poll(() => below(bobs)).toBeGreaterThan(40);
});

test("someone who may only view a workflow watches it change and cannot change it", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid } = await sharedWorkflow(alice, bob, "viewer");

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/workflows/${rid}`);
  await expect(node(bobs, "avg")).toBeVisible();
  await expect(bobs.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "false");

  const palette = await operatorList(page);
  await palette.getByPlaceholder("Search operators").fill("Limit");
  await palette.locator('[data-palette-operator="Limit"]').click();
  await expect(bobs.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  // Bob's canvas offers him nothing to change it with: no list of operators, no pencil on a card.
  await expect(bobs.locator("[data-add-operator]")).toHaveCount(0);
  await bobs.locator('.react-flow__node [data-operator-type="Limit"]').hover();
  await expect(bobs.locator("[data-operator-edit]")).toHaveCount(0);
  // Bob cannot remove it: the key does nothing on his canvas.
  await bobs.locator('.react-flow__node [data-operator-type="Limit"]').click();
  await bobs.keyboard.press("Delete");
  await bobs.waitForTimeout(500);
  await expect(page.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
});

test("a version written elsewhere arrives on an open canvas, beside an edit not saved yet", async ({ page, request }) => {
  const alice = await api(request);
  const { rid } = await aWorkflow(alice, "agent edits");

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(node(page, "avg")).toBeVisible();

  // What an agent's edit_workflow does: a patch through the catalog, as a new version.
  await alice("POST", `/workflows/${rid}/edit`, {
    patch: [
      { op: "add", path: "/operators/-", value: { operatorID: "top", operatorType: "Limit", operatorProperties: { limit: 2 } } },
      { op: "add", path: "/links/-", value: { linkID: "l2", source: { operatorID: "avg", portID: "output-0" }, target: { operatorID: "top", portID: "input-0" } } },
    ],
  });
  await expect(node(page, "top")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  // The person keeps editing on top of it, and the next version holds both.
  const palette = await operatorList(page);
  await palette.getByPlaceholder("Search operators").fill("Sort");
  await palette.locator('[data-palette-operator="Sort"]').click();
  await expect.poll(async () => (await headOf(alice, rid)).spec.operators.map(o => o.operatorType).sort(), { timeout: 20_000 }).toEqual(["Aggregate", "CSVFileScan", "Limit", "Sort"]);
});

test("a workflow the catalog does not take as a version says so on everyone's page, and does not run", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid } = await sharedWorkflow(alice, bob, "editor");
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/workflows/${rid}`);
  await expect(node(bobs, "scan")).toBeVisible();
  const saveState = (on: Page) => on.locator("[data-save-state]");
  await expect(saveState(page)).toHaveAttribute("data-save-state", "saved");

  // Alice points the scan at a file that is not there: the catalog takes no such version.
  const file = (await editOperator(page, "scan")).getByPlaceholder("texera://datasets/<rid>@<vno>/files/file.csv");
  const there = await file.inputValue();
  await file.fill("texera://datasets/00000000-0000-4000-8000-000000000000@1/files/nothing.csv");
  for (const on of [page, bobs]) {
    await expect(saveState(on)).toHaveAttribute("data-save-state", "refused", { timeout: 20_000 });
    await expect(on.locator("[data-not-saved]")).toContainText("nothing.csv does not exist");
  }
  expect((await headOf(alice, rid)).metadata.head).toBe(1);
  await page.screenshot({ path: "test-results/not-saved.png" });
  // A run is of a saved version: it does not start, and says why.
  await page.locator("[data-run]").click();
  await expect(page.getByText(/the workflow is not saved: .*does not exist/)).toBeVisible();
  expect(((await alice("GET", `/workflows/${rid}/executions`)) as { items: unknown[] }).items).toHaveLength(0);
  // Someone who opens the workflow now sees the edit, and that it is not saved.
  await bobs.reload();
  await expect(node(bobs, "scan")).toBeVisible();
  await expect(saveState(bobs)).toHaveAttribute("data-save-state", "refused");

  // Put right, it is saved, and everyone sees that.
  await file.fill(there);
  for (const on of [page, bobs]) {
    await expect(saveState(on)).toHaveAttribute("data-save-state", "saved", { timeout: 20_000 });
    await expect(on.locator("[data-not-saved]")).toHaveCount(0);
  }
});

/** A chat of alice's that bob takes part in, open in both their browsers. */
async function chatOfTwo(page: Page, browser: Browser, alice: Caller, bob: Caller, label: string) {
  const [alicePid, bobPid] = [(await alice("GET", "/me")).principal.pid as string, (await bob("GET", "/me")).principal.pid as string];
  await signIn(page);
  const rid = await openChat(page, alice, `${label} ${Date.now()}`);
  await alice("PUT", `/resources/${rid}/grants/${bobPid}`, { relation: "editor" });
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/conversations/${rid}`);
  await expect(bobs.locator("[data-composer]")).toBeVisible();
  return { rid, bobs, alicePid, bobPid };
}

const box = (page: Page) => page.getByLabel("Message", { exact: true });
const said = (page: Page, text: string) => page.locator('[data-message-role="user"]', { hasText: text });

test("a note is said to the people in a chat from its box, and asks the agent nothing", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid, bobs, alicePid, bobPid } = await chatOfTwo(page, browser, alice, bob, "notes");

  // Bob writes in the box and posts it as a note: on his own page it is marked as one.
  await box(bobs).fill("Use the 2020 data, please.");
  await bobs.locator("[data-send-note]").click();
  await expect(said(bobs, "Use the 2020 data, please.").locator("[data-message-note]")).toBeVisible();
  await expect(box(bobs)).toHaveValue("");
  // On alice's, with no reload: under his name, as a note.
  await expect(said(page, "Use the 2020 data, please.").locator(`[data-message-author="${bobPid}"]`)).not.toBeEmpty();
  await expect(said(page, "Use the 2020 data, please.").locator("[data-message-note]")).toBeVisible();
  // The agent was not asked: the chat holds his message alone, of no turn, and no turn runs.
  const { items } = (await alice("GET", `/conversations/${rid}/messages`)) as { items: { role: string; author: string; turn?: string }[] };
  expect(items.map(m => [m.role, m.author, m.turn ?? null])).toEqual([["user", bobPid, null]]);
  expect((await alice("GET", `/conversations/${rid}`)).status?.activeTurn).toBeUndefined();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);

  // While alice's turn runs bob cannot ask the agent, and can still say something to her.
  const turn = await alice("POST", `/conversations/${rid}/turns`, {});
  await expect(bobs.locator(`[data-turn-of="${alicePid}"]`)).toBeVisible();
  await box(bobs).fill("Take your time.");
  await expect(bobs.getByLabel("Send message")).toBeDisabled();
  await bobs.locator("[data-send-note]").click();
  await expect(said(page, "Take your time.").locator("[data-message-note]")).toBeVisible();
  await alice("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
  await expect(bobs.locator(`[data-turn-of="${alicePid}"]`)).toHaveCount(0);
  await bobs.screenshot({ path: "test-results/chat-notes.png" });
});

test("what a chat runs with is one choice for everyone in it, and changes on every page at once", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { rid, bobs } = await chatOfTwo(page, browser, alice, bob, "one configuration");
  const addOns = (on: Page) => on.locator("[data-composer] [data-chat-add-ons]");
  await expect(addOns(page)).toHaveAttribute("data-chat-add-ons", "1");
  await expect(addOns(bobs)).toHaveAttribute("data-chat-add-ons", "1");

  // Alice turns the add-on off in her box: bob's box says so with no reload.
  await addOns(page).click();
  await page.locator('[data-add-on="biomcp"]').click();
  await page.keyboard.press("Escape");
  await expect(addOns(page)).toHaveAttribute("data-chat-add-ons", "0");
  await expect(addOns(bobs)).toHaveAttribute("data-chat-add-ons", "0");
  // Bob turns it back on: it is the chat's choice, so alice's box follows, and so does what a turn runs with.
  await addOns(bobs).click();
  await bobs.locator('[data-add-on="biomcp"]').click();
  await bobs.keyboard.press("Escape");
  await expect(addOns(page)).toHaveAttribute("data-chat-add-ons", "1");
  const runsWith = (await alice("GET", `/conversations/${rid}/settings`)) as { mcpServers: { name: string }[] };
  expect(runsWith.mcpServers.map(m => m.name).sort()).toEqual(["biomcp", "catalog"]);
});

test("one of two people asks the agent, which knows who said what, and the other watches the answer arrive", async ({ page, browser, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(240_000);
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const { bobs, alicePid } = await chatOfTwo(page, browser, alice, bob, "asked together");

  // Bob tells the others something only he knows, as a note; then alice asks the agent about it.
  await box(bobs).fill("My lucky number is 41.");
  await bobs.locator("[data-send-note]").click();
  await expect(said(page, "My lucky number is 41.")).toBeVisible();
  await say(page, "What is Bob's lucky number plus one? Start your answer with the number alone, then explain in about 150 words how you know whose number it is and who is asking.");

  // Bob sees whose turn it is, and the answer arriving on his page while the turn still runs.
  const turnOf = bobs.locator(`[data-turn-of="${alicePid}"]`);
  const onBobs = bobs.locator('[data-message-role="assistant"]');
  await expect(async () => {
    expect(await turnOf.count()).toBe(1);
    expect(await onBobs.count()).toBeGreaterThan(0);
    expect((await onBobs.last().innerText()).trim()).not.toBe("");
  }).toPass({ timeout: 90_000, intervals: [100] });
  await bobs.screenshot({ path: "test-results/chat-answer-arriving.png" });

  // The whole answer on both pages; it used what bob said, under his name, to answer alice.
  await expect(turnOf).toHaveCount(0, { timeout: 150_000 });
  for (const on of [page, bobs]) {
    const answer = on.locator('[data-message-role="assistant"]').last();
    await expect(answer).toContainText("42");
    await expect(answer).toContainText("Bob");
    await expect(answer).toContainText("Alice");
  }
});
