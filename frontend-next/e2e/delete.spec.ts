import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, type Caller, cleanups, confirmDelete, type Envelope, IRIS_CSV, inTurn, signIn, tidyUp, workAtHome } from "./support";

// Deleting is the same wherever a resource shows: a bin on its header and on its row of a list
// (the sidebar's chats, a project's lists, a library), for whoever may delete it, then one
// question that names the thing and says what goes with it. What the catalog refuses is said in
// the same place, with what stands in the way. Whatever showed the thing no longer does.

test.afterEach(tidyUp);

const dialog = (page: Page) => page.locator("[data-delete-dialog]");
const gone = async (as: Caller, rid: string) => (await as.status("GET", `/resources/${rid}`)) === 404;
/** Removes what a scenario did not get to delete itself, in the order given: a workflow goes with its executions. */
async function sweep(as: Caller, rids: string[]) {
  for (const rid of rids) if (!(await gone(as, rid))) await as.attempt("DELETE", `/resources/${rid}`);
}

async function browserOf(browser: Browser, user: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  cleanups.push(() => context.close());
  return page;
}

/** A row's bin shows once the row is pointed at; pointing is also what asks whether the person may. */
async function binOf(row: ReturnType<Page["locator"]>) {
  await row.hover();
  const bin = row.locator("[data-delete-row]");
  await expect(bin).toBeVisible();
  return bin;
}

test("a chat, a dataset and a workflow are deleted the same way, from a list or from their page", async ({ page, browser, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `to tidy ${stamp}`, spec: {} });
  const P = project.metadata.rid;
  const dataset = async (name: string) => {
    const made: Envelope = await alice("POST", "/datasets", { name, parent: P, spec: { format: "csv" } });
    await alice("PUT", `/datasets/${made.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
    await alice("POST", `/datasets/${made.metadata.rid}/commit`, { message: "iris" });
    return made;
  };
  const read = await dataset(`flowers read ${stamp}`);
  const spare = await dataset(`flowers spare ${stamp}`);
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `petals ${stamp}`,
    parent: P,
    spec: { operators: [{ operatorID: "scan", operatorType: "CSVFileScan", viewResult: true, operatorProperties: { fileName: `${read.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } }], links: [] },
  });
  const chat = async (name: string) => (await alice("POST", "/conversations", { name, parent: P, spec: {} })) as Envelope;
  const [first, second] = [await chat(`first chat ${stamp}`), await chat(`second chat ${stamp}`)];
  // Whatever the test did not get to delete goes at the end.
  cleanups.push(async () => {
    await sweep(alice, [workflow.metadata.rid, first.metadata.rid, second.metadata.rid, read.metadata.rid, spare.metadata.rid, P]);
    await workAtHome(alice);
  });
  const execution = await alice("POST", `/workflows/${workflow.metadata.rid}/run`, { waitSeconds: 180 });
  expect(execution.status.phase).toBe("completed");
  // Bob edits in the project: he changes what is there, and deletes none of it.
  const bobPid = (await (await api(request, "bob"))("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${P}/grants/${bobPid}`, { relation: "editor" });
  await alice("PUT", "/me/preferences", { ...((await alice("GET", "/me")).preferences as object), project: P });

  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const chatRow = (c: Envelope) => page.locator(`[data-chat-row="${c.metadata.rid}"]`);

  await test.step("a chat, from the sidebar: asked first, and Cancel keeps it", async () => {
    await expect(chatRow(first)).toBeVisible();
    await (await binOf(chatRow(first))).click();
    await expect(dialog(page)).toHaveAttribute("data-delete-dialog", "conversation");
    await expect(page.getByRole("heading", { name: "Delete this chat?" })).toBeVisible();
    await expect(dialog(page).locator("[data-delete-name]")).toHaveText(first.metadata.name);
    await expect(dialog(page)).toContainText("What the chat made stays in the project");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await gone(alice, first.metadata.rid)).toBe(false);
    // The bin did not open the chat: the page is still the start page.
    await expect(page).toHaveURL(/\/$/);

    await confirmDelete(page, await binOf(chatRow(first)));
    await expect(chatRow(first)).toHaveCount(0);
    await expect(chatRow(second)).toBeVisible();
    expect(await gone(alice, first.metadata.rid)).toBe(true);
  });

  await test.step("a chat, from its own page: the page is left for the start page", async () => {
    await chatRow(second).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${second.metadata.rid}`));
    await confirmDelete(page, page.locator('[data-chat-header] [data-delete="conversation"]'));
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(chatRow(second)).toHaveCount(0);
    expect(await gone(alice, second.metadata.rid)).toBe(true);
  });

  const overviewRow = (name: string) => page.locator("[data-project-overview] [data-resource-row]").filter({ hasText: name });
  await test.step("a dataset a workflow reads stays, and the question says what uses it", async () => {
    await page.goto(`/projects/${P}`);
    await confirmDelete(page, await binOf(overviewRow(read.metadata.name)));
    const refused = page.locator("[data-delete-refused]");
    await expect(refused).toContainText("something still uses it");
    await expect(refused.locator('[data-uri-chip="workflow"]')).toHaveText(workflow.metadata.name);
    expect(await gone(alice, read.metadata.rid)).toBe(false);
    await page.screenshot({ path: "test-results/delete-refused.png" });
    // What uses it is a link: it opens beside the page, and the question gets out of its way.
    await refused.locator('[data-uri-chip="workflow"]').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(`[data-workflow-view="${workflow.metadata.rid}"]`)).toBeVisible();
    // Neither the bin nor the link left the project's page.
    expect(new URL(page.url()).pathname).toBe(`/projects/${P}`);
  });

  await test.step("a workflow, from its page: its execution goes with it, and the page is left for the project", async () => {
    await page.goto(`/workflows/${workflow.metadata.rid}`);
    await page.locator('[data-resource-header] [data-delete="workflow"]').click();
    await expect(dialog(page)).toContainText("its execution with its results");
    await page.screenshot({ path: "test-results/delete-workflow.png" });
    await page.locator("[data-delete-confirm]").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${P}$`), { timeout: 30_000 });
    await expect(overviewRow(workflow.metadata.name)).toHaveCount(0);
    expect(await gone(alice, workflow.metadata.rid)).toBe(true);
    expect(await gone(alice, execution.metadata.rid)).toBe(true);
  });

  await test.step("the dataset nothing reads any more, from the project's list", async () => {
    await expect(overviewRow(read.metadata.name)).toBeVisible();
    await confirmDelete(page, await binOf(overviewRow(read.metadata.name)));
    await expect(overviewRow(read.metadata.name)).toHaveCount(0, { timeout: 20_000 });
    await expect(overviewRow(spare.metadata.name)).toBeVisible();
    expect(await gone(alice, read.metadata.rid)).toBe(true);
  });

  await test.step("someone who may not delete gets no bin, on a row or on the page", async () => {
    const bobs = await browserOf(browser, "bob");
    await bobs.goto(`/projects/${P}`);
    const row = bobs.locator("[data-project-overview] [data-resource-row]").filter({ hasText: spare.metadata.name });
    await row.hover();
    await bobs.waitForTimeout(1500);
    await expect(row.locator("[data-delete]")).toHaveCount(0);
    await bobs.goto(`/datasets/${spare.metadata.rid}`);
    await expect(bobs.locator("[data-resource-name]")).toBeEnabled();
    await bobs.waitForTimeout(1500);
    await expect(bobs.locator("[data-delete]")).toHaveCount(0);
  });

  await test.step("a dataset, from the library's list and beside it", async () => {
    await page.goto("/datasets");
    const row = page.locator('[data-library="dataset"] [data-resource-row]').filter({ hasText: spare.metadata.name });
    await (await binOf(row)).click();
    await expect(page.getByRole("heading", { name: "Delete this dataset?" })).toBeVisible();
    await expect(dialog(page)).toContainText("Every version of it goes, with its files");
    await page.screenshot({ path: "test-results/delete-dataset.png" });
    await page.locator("[data-delete-confirm]").click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    expect(await gone(alice, spare.metadata.rid)).toBe(true);
  });
});

test("a workflow goes from the graph beside its chat, and the chat stays", async ({ page, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `to tidy beside ${stamp}`, spec: {} });
  const P = project.metadata.rid;
  const conversation: Envelope = await alice("POST", "/conversations", { name: `made a flow ${stamp}`, parent: P, spec: {} });
  const C = conversation.metadata.rid;
  // The workflow is made in a turn of the chat, as the agent makes it: it is the chat's.
  const agent = await inTurn(request, alice, C);
  const workflow: Envelope = await agent("POST", "/workflows", { name: `flow of the chat ${stamp}`, parent: P, spec: { operators: [], links: [] } });
  await agent("POST", `/conversations/${C}/messages`, { turn: agent.turn, role: "assistant", parts: [{ type: "text", text: "Made it." }] });
  await agent.end();
  cleanups.push(async () => {
    await sweep(alice, [workflow.metadata.rid, C, P]);
  });

  await page.setViewportSize({ width: 1500, height: 900 });
  await signIn(page);
  await page.goto(`/conversations/${C}`);
  const node = page.locator('[data-resource-panel] [data-graph-role="workflow"]').filter({ hasText: workflow.metadata.name });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  const view = page.locator("[data-resource-panel] [data-workflow-view]");
  await expect(view).toBeVisible();
  await confirmDelete(page, view.locator('[data-delete="workflow"]'));
  // Back on the graph, which no longer draws it; the chat is where it was.
  await expect(view).toHaveCount(0, { timeout: 20_000 });
  await expect(node).toHaveCount(0, { timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/conversations/${C}`));
  await expect(page.locator("[data-composer]")).toBeVisible();
  expect(await gone(alice, workflow.metadata.rid)).toBe(true);
  expect(await gone(alice, C)).toBe(false);
});
