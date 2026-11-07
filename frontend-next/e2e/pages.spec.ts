import { expect, test } from "@playwright/test";
import { api, cleanups, type Envelope, IRIS_CSV, signIn, tidyUp, workIn } from "./support";

// The pages say what they show: search opens what matches, a library lists all of a kind, a
// preview says it is one, and a list opens from its first option.

test.afterEach(tidyUp);

test("search opens what matches with Enter; with nothing typed it offers a new chat first", async ({ page, request }) => {
  const alice = await api(request);
  const stamp = Date.now();
  const workflow: Envelope = await alice("POST", "/workflows", { name: `findable petals ${stamp}`, spec: { operators: [], links: [] } });
  cleanups.push(() => alice.attempt("DELETE", `/resources/${workflow.metadata.rid}`));
  await signIn(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Search workflows, datasets, agents, chats…");
  await expect(input).toBeVisible();
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toContainText("New chat");
  await input.fill(`findable petals ${stamp}`);
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toContainText(`findable petals ${stamp}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/workflows/${workflow.metadata.rid}`));
});

test("a library lists every one of its kind, not the first hundred", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-library-link="operator"]').click();
  const rows = page.locator('[data-library="operator"] [data-resource-row]');
  await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(100);
  await expect(rows.filter({ hasText: /^Limit/ }).first()).toBeAttached();
  await expect(rows.filter({ hasText: /^Projection/ }).first()).toBeAttached();
});

test("a file's preview says it shows the first rows, of how many", async ({ page, request }) => {
  const alice = await api(request);
  const dataset: Envelope = await alice("POST", "/datasets", { name: `iris ${Date.now()}`, spec: { format: "csv" } });
  cleanups.push(() => alice.attempt("DELETE", `/resources/${dataset.metadata.rid}`));
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "iris" });
  await signIn(page);
  await page.goto(`/datasets/${dataset.metadata.rid}`);
  await expect(page.locator('[data-file="iris.csv"]')).toBeVisible();
  await expect(page.locator("[data-preview-count]")).toHaveText("The first 100 rows, of 150.");
});

test("a list opens from its first option, whichever is picked", async ({ page, request }) => {
  const alice = await api(request);
  const stamp = Date.now();
  const made: Envelope[] = [];
  for (const n of [1, 2, 3, 4, 5, 6]) made.push(await alice("POST", "/projects", { name: `zz picker ${stamp} ${n}`, spec: {} }));
  cleanups.push(async () => {
    for (const p of made) await alice.attempt("DELETE", `/projects/${p.metadata.rid}`);
  });
  await signIn(page);
  await workIn(page, `zz picker ${stamp} 6`);
  await page.getByLabel("Project", { exact: true }).click();
  const personal = page.getByRole("option", { name: "Personal", exact: true });
  await expect(personal).toBeVisible();
  const list = await page.getByRole("listbox").boundingBox();
  const first = await personal.boundingBox();
  expect(first && list && first.y >= list.y).toBe(true);
  await page.keyboard.press("Escape");
  await workIn(page, "Personal");
});
