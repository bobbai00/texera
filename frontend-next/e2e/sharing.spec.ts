import { type Browser, expect, type Page, test } from "@playwright/test";
import { aPageOfEveryKind, api, type Caller, cleanups, discard, type Envelope, IRIS_CSV, signIn, tidyUp } from "./support";

// Sharing: a person shares a resource from its page, the other finds it under "Shared with me"
// and opens it. A link to something that was not shared says so, on the page of every kind,
// and opens once it is; a grant taken back closes it again.

test.afterEach(tidyUp);

const BOB = "Bob Builder";

/** Another person's own browser, signed in. */
async function browserOf(browser: Browser, user: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  cleanups.push(() => context.close());
  return page;
}

const pathOf = (r: Envelope) => `/${r.metadata.uri.replace("texera://", "")}`;
const cannotOpen = (page: Page) => page.locator("[data-cannot-open]");
const header = (page: Page) => page.locator("[data-resource-header], [data-chat-header]").first();
const sharedRow = (page: Page, name: string) => page.locator("[data-shared-with-me] [data-resource-row]").filter({ hasText: name });
/** A person's row among the people a resource is shared with, in the share dialog. */
const grantOf = (page: Page, name: string) => page.locator("[data-share-dialog] [data-grants] [data-grant]").filter({ hasText: name });

/** A project, a chat, a workflow and a dataset of alice's, each named for this scenario. */
async function fourOfAlices(alice: Caller) {
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `shared lab ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: `shared flowers ${stamp}`, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "Fisher's iris flowers" });
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `shared petals ${stamp}`,
    spec: {
      operators: [
        { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
        { operatorID: "top", operatorType: "Limit", operatorProperties: { limit: 5 } },
      ],
      links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "top", portID: "input-0" } }],
    },
  });
  const chat: Envelope = await alice("POST", "/conversations", { name: `shared chat ${stamp}`, spec: {} });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [chat.metadata.rid, dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  return { project, chat, workflow, dataset };
}

/** What shows that each kind's page really opened, beyond its header. */
const opened: Record<string, (page: Page, r: Envelope) => Promise<void>> = {
  project: async (page, r) => expect(page.locator("[data-resource-header] [data-resource-name]")).toHaveValue(r.metadata.name),
  conversation: async (page, r) => expect(page.locator("[data-chat-header]")).toContainText(r.metadata.name),
  workflow: async page => expect(page.locator('.react-flow__node[data-id="top"]')).toBeVisible(),
  dataset: async page => expect(page.locator("[data-file]").filter({ hasText: "iris.csv" })).toBeVisible(),
};

test("what a person shares from its page, the other finds under Shared with me and opens: a project, a chat, a workflow, a dataset", async ({ page, browser, request, context }) => {
  test.setTimeout(180_000);
  const alice = await api(request);
  const made = await fourOfAlices(alice);
  const all = [made.project, made.chat, made.workflow, made.dataset];
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // Bob has none of them yet.
  const bobs = await browserOf(browser, "bob");
  await bobs.locator("[data-shared-link]").click();
  await expect(bobs.locator("[data-shared-with-me]")).toBeVisible();
  for (const r of all) await expect(sharedRow(bobs, r.metadata.name)).toHaveCount(0);

  // Alice shares each from its own page: the Share button at the top right.
  await signIn(page);
  for (const r of all) {
    await test.step(`alice shares the ${r.kind}`, async () => {
      await page.goto(pathOf(r));
      await header(page).locator("[data-share]").click();
      const dialog = page.locator("[data-share-dialog]");
      // The link is the page's own address, and copies.
      await expect(dialog.locator("[data-share-link]")).toHaveValue(new URL(pathOf(r), page.url()).toString());
      await dialog.locator("[data-copy-link]").click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(pathOf(r), page.url()).toString());
      // Only its owner so far, whose own grant is not one to take back; then bob, who may take
      // part in the chat and look at the rest.
      await expect(dialog.locator("[data-grants] [data-grant]")).toHaveCount(1);
      await expect(grantOf(page, "Alice Liddell")).toHaveAttribute("data-grant", "owner");
      await expect(grantOf(page, "Alice Liddell").getByLabel("Revoke")).toHaveCount(0);
      const relation = r.kind === "conversation" ? "editor" : "viewer";
      await dialog.getByLabel("Principal").fill("bob");
      await dialog.locator(`[data-principal="${BOB}"]`).click();
      await dialog.getByLabel("Relation").selectOption(relation);
      await dialog.locator("[data-grant-button]").click();
      await expect(grantOf(page, BOB)).toHaveAttribute("data-grant", relation);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });
  }
  await page.goto(pathOf(made.workflow));
  await header(page).locator("[data-share]").click();
  await expect(grantOf(page, BOB)).toHaveCount(1);
  await page.screenshot({ path: "test-results/share-dialog.png" });

  // Bob finds all four in one list, whatever project they live in, and opens each.
  await bobs.reload();
  for (const r of all) await expect(sharedRow(bobs, r.metadata.name)).toHaveCount(1);
  await bobs.screenshot({ path: "test-results/shared-with-me.png" });
  for (const r of all) {
    await test.step(`bob opens the ${r.kind}`, async () => {
      await bobs.goto("/shared");
      await sharedRow(bobs, r.metadata.name).getByRole("button", { name: r.metadata.name }).click();
      await expect(bobs).toHaveURL(new RegExp(`${pathOf(r)}$`));
      await expect(header(bobs)).toBeVisible();
      await expect(cannotOpen(bobs)).toHaveCount(0);
      await opened[r.kind]?.(bobs, r);
    });
  }
  // What he may do there is what he was given: he takes part in the chat, he looks at the workflow.
  await bobs.goto(pathOf(made.chat));
  await expect(bobs.getByLabel("Message", { exact: true })).toBeEnabled();
  await bobs.goto(pathOf(made.workflow));
  await expect(bobs.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "false");
  // The project he was given is also one he can work in.
  await bobs.getByLabel("Project", { exact: true }).click();
  await expect(bobs.getByRole("option", { name: made.project.metadata.name })).toBeVisible();
});

test("a link to something that was not shared says so on the page of every kind, and opens once it is shared", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const bob = await api(request, "bob");
  const { pages, project } = await aPageOfEveryKind(alice);
  const chat: Envelope = await alice("POST", "/conversations", { name: `not shared ${Date.now()}`, parent: project, spec: {} });
  cleanups.push(() => alice.attempt("DELETE", `/resources/${chat.metadata.rid}`));
  const alices = [...pages.filter(p => p.mine).map(p => ({ kind: p.kind, path: p.path })), { kind: "conversation", path: pathOf(chat) }];
  expect(alices.map(p => p.kind).sort()).toEqual(["conversation", "credential", "dataset", "execution", "model", "model-endpoint", "profile", "project", "skill", "warehouse", "workflow"]);

  const bobs = await browserOf(browser, "bob");
  for (const at of alices) {
    await test.step(`${at.kind}: not shared`, async () => {
      await bobs.goto(at.path);
      await expect(cannotOpen(bobs)).toHaveAttribute("data-cannot-open", "forbidden");
      await expect(cannotOpen(bobs)).toContainText("has not been shared with you");
      await expect(header(bobs)).toHaveCount(0);
    });
  }
  await bobs.screenshot({ path: "test-results/not-shared.png" });
  // A link to nothing says that instead.
  await bobs.goto("/workflows/00000000-0000-4000-8000-000000000000");
  await expect(cannotOpen(bobs)).toHaveAttribute("data-cannot-open", "not_found");

  // Alice shares the project they all live in: every one of the links opens.
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${project}/grants/${bobPid}`, { relation: "viewer" });
  for (const at of alices) {
    await test.step(`${at.kind}: shared`, async () => {
      await bobs.goto(at.path);
      await expect(header(bobs)).toBeVisible();
      await expect(cannotOpen(bobs)).toHaveCount(0);
    });
  }
});

test("a grant taken back takes the thing off the other's list and closes its page", async ({ page, browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob");
  const made = await fourOfAlices(alice);
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${made.workflow.metadata.rid}/grants/${bobPid}`, { relation: "editor" });

  // Bob has the workflow open, and alice sees him there.
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(pathOf(made.workflow));
  await expect(bobs.locator('.react-flow__node[data-id="top"]')).toBeVisible();
  await signIn(page);
  await page.goto(pathOf(made.workflow));
  await expect(page.locator("[data-presence] [data-present]")).toHaveCount(2);

  // Alice takes it back in the same dialog.
  await header(page).locator("[data-share]").click();
  const dialog = page.locator("[data-share-dialog]");
  await expect(dialog).toBeVisible();
  await grantOf(page, BOB).getByLabel("Revoke").click();
  await expect(grantOf(page, BOB)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The page bob has open closes without a reload: the session lets him go, and the page says why.
  await expect(cannotOpen(bobs)).toHaveAttribute("data-cannot-open", "forbidden", { timeout: 60_000 });
  await expect(page.locator("[data-presence] [data-present]")).toHaveCount(1);
  // It is off his list, and the link no longer opens.
  await bobs.goto("/shared");
  await expect(bobs.locator("[data-shared-with-me]")).toBeVisible();
  await expect(sharedRow(bobs, made.workflow.metadata.name)).toHaveCount(0);
  await bobs.goto(pathOf(made.workflow));
  await expect(cannotOpen(bobs)).toHaveAttribute("data-cannot-open", "forbidden");
});

// Sharing a workflow says, under the person it is shared with, what they cannot open of what it
// uses (its lineage: the dataset it reads), and one step shares that with them too.
test("sharing a workflow says what the person cannot open of what it uses, and shares that too in one step", async ({ page, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob");
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `uses ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: `iris ${stamp}`, parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, {});
  const scan = { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } };
  const workflow: Envelope = await alice("POST", "/workflows", { name: `reads iris ${stamp}`, parent: project.metadata.rid, spec: { operators: [scan], links: [] } });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });

  await signIn(page);
  await page.goto(pathOf(workflow));
  await header(page).locator("[data-share]").click();
  const dialog = page.locator("[data-share-dialog]");
  await dialog.getByLabel("Principal").fill("bob");
  await dialog.locator(`[data-principal="${BOB}"]`).click();
  await dialog.getByLabel("Relation").selectOption("viewer");
  await dialog.locator("[data-grant-button]").click();

  // Bob cannot open the dataset the workflow reads, and the dialog says so under his name.
  const needs = grantOf(page, BOB).locator("[data-needs]");
  await expect(needs).toContainText(`Can't open 1 thing this uses: iris ${stamp}`);
  await page.screenshot({ path: "test-results/share-needs.png" });
  await needs.locator("[data-share-needs]").click();
  await expect(needs).toHaveCount(0);
  expect((await bob("GET", `/datasets/${dataset.metadata.rid}`)).metadata.name).toBe(`iris ${stamp}`);
});

test("a person shared a workflow but not what it reads is told, before Run, what is missing and whom to ask", async ({ browser, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob");
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `lent workflow ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "iris" });
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `petals ${stamp}`,
    parent: project.metadata.rid,
    spec: {
      operators: [{ operatorID: "scan", operatorType: "CSVFileScan", viewResult: true, operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } }],
      links: [],
    },
  });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${workflow.metadata.rid}/grants/${bobPid}`, { relation: "viewer" });

  const bobs = await browserOf(browser, "bob");
  await bobs.goto(pathOf(workflow));
  // Said once, above the canvas, with what is on screen: the operator, the file; and on its card.
  const blocked = bobs.locator("[data-run-blocked]");
  await expect(blocked).toContainText("You can look at this workflow but not run it.");
  await expect(blocked).toContainText("CSV File Scan reads iris.csv, from a dataset not shared with you. Ask the workflow's owner to share it with you.");
  await expect(blocked).not.toContainText("texera://");
  await expect(bobs.locator('.react-flow__node[data-id="scan"] [data-operator-error]')).toContainText("Not shared with you");
  // Run says the same, not "the caller may not do this".
  await bobs.locator("[data-run]").click();
  await expect(bobs.getByText("Could not start the execution")).toHaveCount(0);
  await expect(bobs.getByText("the caller may not do this")).toHaveCount(0);

  // Once the dataset is shared too, the page says nothing more, and Bob's run goes.
  await alice("PUT", `/resources/${dataset.metadata.rid}/grants/${bobPid}`, { relation: "viewer" });
  await bobs.reload();
  await expect(bobs.locator('[data-workflow-canvas]')).toBeVisible();
  await expect(blocked).toHaveCount(0);
  await bobs.locator("[data-run]").click();
  await expect(bobs.locator('[data-latest-execution="completed"]')).toBeVisible({ timeout: 120_000 });
});

test("a person is offered only what the catalog lets them do: a viewer reads, an editor changes, only the owner deletes", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const bob = await api(request, "bob");
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `lent things ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "iris" });
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `petals ${stamp}`,
    parent: project.metadata.rid,
    spec: { operators: [{ operatorID: "scan", operatorType: "CSVFileScan", viewResult: true, operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } }], links: [] },
  });
  const execution = await alice("POST", `/workflows/${workflow.metadata.rid}/run`, { waitSeconds: 180 });
  const chat: Envelope = await alice("POST", "/conversations", { name: `lent chat ${stamp}`, parent: project.metadata.rid, spec: {} });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid, chat.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  const bobPid = (await bob("GET", "/me")).principal.pid as string;

  for (const relation of ["viewer", "editor"] as const) {
    await alice("PUT", `/resources/${project.metadata.rid}/grants/${bobPid}`, { relation });
    const bobs = await browserOf(browser, "bob");
    const writes = relation === "editor";
    await bobs.goto(pathOf(dataset));
    await expect(bobs.locator("[data-resource-view]")).toBeVisible();
    // Only an editor renames; nobody but the owner deletes.
    await expect(bobs.locator("[data-resource-name]")).toBeEnabled({ enabled: writes });
    await bobs.waitForTimeout(1000);
    await expect(bobs.locator("[data-delete]")).toHaveCount(0);
    await bobs.goto(`/workflows/${workflow.metadata.rid}/executions/${execution.metadata.rid}`);
    await expect(bobs.locator("[data-results]")).toBeVisible();
    await expect(bobs.locator("[data-keep-execution]")).toHaveCount(writes ? 1 : 0);
    await expect(bobs.locator("[data-delete-execution]")).toHaveCount(0);
    await bobs.goto(pathOf(project));
    await expect(bobs.locator("[data-resource-view]")).toBeVisible();
    await expect(bobs.locator("[data-work-here]")).toHaveCount(writes ? 1 : 0);
    // A reader of a chat follows it; the box says so instead of failing on send.
    await bobs.goto(pathOf(chat));
    await expect(bobs.getByLabel("Message", { exact: true })).toBeEnabled({ enabled: writes });
    await expect(bobs.locator("[data-chat-read-only]")).toHaveCount(writes ? 0 : 1);
  }
  await alice("DELETE", `/resources/${project.metadata.rid}/grants/${bobPid}`);
});
