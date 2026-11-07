import { expect, test } from "@playwright/test";
import { api, cleanups, discard, type Envelope, IRIS_CSV, signIn, tidyUp } from "./support";

// A resource's page keeps what the person is doing: an edit in progress survives a rename and
// someone else's save, which is said, not lost; deleting something takes it off every page that
// showed it.

test.afterEach(tidyUp);

test("an edit in progress survives a rename, and a save over someone else's change asks whose to keep", async ({ page, request }) => {
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `skills ${stamp}`, spec: {} });
  const skill: Envelope = await alice("POST", "/skills", {
    name: `petal facts ${stamp}`,
    parent: project.metadata.rid,
    spec: { name: `petal-facts-${stamp}`, description: "What to know about petals", body: "Petals are measured in cm." },
  });
  cleanups.push(async () => {
    await alice.attempt("DELETE", `/resources/${skill.metadata.rid}`);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  await signIn(page);
  await page.goto(`/skills/${skill.metadata.rid}`);
  await page.getByRole("tab", { name: /Settings|Skill/ }).click();
  await page.locator('[data-spec-editor] button:has-text("JSON")').click();
  const json = page.locator("[data-spec-json]");
  const mine = { name: `petal-facts-${stamp}`, description: "What to know about petals", body: "Petals and sepals are measured in cm." };
  await json.fill(JSON.stringify(mine, null, 2));

  // A rename while editing leaves the edit where it is.
  const name = page.locator("[data-resource-name]");
  await name.fill(`petal facts, renamed ${stamp}`);
  await name.press("Enter");
  await expect.poll(async () => (await alice("GET", `/resources/${skill.metadata.rid}`)).metadata.name).toBe(`petal facts, renamed ${stamp}`);
  await page.waitForTimeout(800);
  await expect(json).toHaveValue(JSON.stringify(mine, null, 2));
  await expect(page.locator("[data-save-spec]")).toBeEnabled();

  // Someone else saves the spec meanwhile: the page says so and keeps the edit.
  const current = await alice("GET", `/resources/${skill.metadata.rid}`);
  await alice("PUT", `/skills/${skill.metadata.rid}`, { spec: { ...current.spec, body: "Theirs: petals only." }, expectedHead: current.metadata.head });
  await expect(page.locator("[data-spec-changed]")).toBeVisible({ timeout: 20_000 });
  await expect(json).toHaveValue(JSON.stringify(mine, null, 2));
  // Keep mine, then save: it goes over theirs.
  await page.locator("[data-keep-mine]").click();
  await page.locator("[data-save-spec]").click();
  await expect.poll(async () => (await alice("GET", `/resources/${skill.metadata.rid}`)).spec.body, { timeout: 20_000 }).toBe(mine.body);
  await expect(page.getByText("Could not save")).toHaveCount(0);
});

test("deleting an execution takes it off its workflow's page, and deleting a project leaves its page", async ({ page, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `to delete ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "iris" });
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `petals ${stamp}`,
    parent: project.metadata.rid,
    spec: { operators: [{ operatorID: "scan", operatorType: "CSVFileScan", viewResult: true, operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } }], links: [] },
  });
  // The test deletes them itself; what is left if it stops early goes at the end.
  let deleted = false;
  cleanups.push(async () => {
    if (!deleted) await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  for (let i = 0; i < 2; i++) await alice("POST", `/workflows/${workflow.metadata.rid}/run`, { waitSeconds: 180 });

  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await expect(page.getByRole("tab", { name: "Executions (2)" })).toBeVisible();
  const shown = await page.locator("[data-results]").getAttribute("data-results");
  await page.locator("[data-open-execution]").click();
  await page.locator("[data-delete-execution]").click();
  // The workflow's page counts one, and its results window shows the other execution.
  await expect(page.getByRole("tab", { name: "Executions (1)" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator("[data-results]").getAttribute("data-results"), { timeout: 20_000 }).not.toBe(shown);

  // A project deleted from its own page leaves it.
  await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
  deleted = true;
  await page.goto(`/projects/${project.metadata.rid}`);
  await expect(page.locator("[data-resource-view]")).toBeVisible();
  page.once("dialog", dialog => void dialog.accept());
  await page.locator("[data-delete]").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
});
