import { expect, type Page, test } from "@playwright/test";

// The core loop against the real stack: sign in through Keycloak as alice, start a chat in a
// mode, attach a CSV (which becomes a dataset version), and see it as a card. Resources then
// open beside the chat, and a template can be created from the library.

const USER = process.env.TEXERA_E2E_USER ?? "alice";
const PASSWORD = process.env.TEXERA_E2E_PASSWORD ?? "alice";

async function signIn(page: Page, user = USER, password = PASSWORD) {
  await page.goto("/");
  await page.getByTestId("sign-in").or(page.locator("[data-sign-in]")).first().click();
  // Keycloak's login form.
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.locator("[data-new-chat]")).toBeVisible();
}

test("signs in, starts a chat in a mode and attaches a CSV that becomes a dataset", async ({ page }) => {
  await signIn(page);

  // Pick the first mode (the seeded "Data Analyst" or "General" template) and start.
  const modes = page.locator("[data-mode]");
  await expect(modes.first()).toBeVisible();
  await modes.first().click();
  await page.locator("[data-start-chat]").click();
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.locator("[data-composer]")).toBeVisible();

  // Attach a CSV and send: the upload makes a dataset version before the agent is asked.
  await page.locator("[data-attach-input]").setInputFiles({
    name: "penguins.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("species,island,bill_length_mm\nAdelie,Torgersen,39.1\nGentoo,Biscoe,46.1\n"),
  });
  await page.getByLabel("Message", { exact: true }).fill("What is in this file?");
  await page.getByLabel("Send message").click();
  await expect(page.locator('[data-resource-card="dataset"]').first()).toBeVisible();

  // The dataset opens beside the chat and shows its file.
  await page.locator('[data-resource-card="dataset"] [aria-label="Open beside"]').first().click();
  await expect(page.locator("[data-dataset-view]")).toBeVisible();
  await expect(page.locator("[data-dataset-view]").getByText("penguins.csv").first()).toBeVisible();
  await expect(page).toHaveURL(/panel=dataset%3A|panel=dataset:/);
});

test("lists the library and creates an agent template", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-library-link="agent_template"]').click();
  await expect(page.locator('[data-library="agent_template"]')).toBeVisible();
  await page.locator('[data-new="agent_template"]').click();
  const name = `E2E template ${Date.now()}`;
  await page.locator('[data-new-resource="agent_template"] input').first().fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("[data-template-view]")).toBeVisible();
  await expect(page.locator("[data-template-form]")).toBeVisible();
  await expect(page).toHaveURL(/\/t\//);
});

// The core loop with the real model (needs ANTHROPIC_API_KEY in the agent runtime): bob asks the
// Data Analyst a question about his iris dataset; the agent builds and runs a workflow through
// the Texera MCP server; the answer arrives, and the workflow it built is listed as a resource of
// this chat and opens beside it with its canvas, versions and lineage.
test("a Data Analyst chat answers from a workflow it built and the chat tracks it", async ({ page }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(300_000);
  await signIn(page, "bob", "bob");
  await page.locator("[data-mode]").filter({ hasText: "Data Analyst" }).first().click();
  await page.locator("[data-start-chat]").click();
  await expect(page).toHaveURL(/\/c\//);
  await page
    .getByLabel("Message", { exact: true })
    .fill("Using my dataset named iris, what is the average petal length for each species? Build and run a Texera workflow to compute it.");
  await page.getByLabel("Send message").click();

  const answer = page.locator('[data-message-role="assistant"]').last();
  await expect(answer).toContainText("1.462", { timeout: 240_000 });
  await expect(answer).toContainText("5.552");

  const built = page.locator('[data-rail-item="workflow"]').first();
  await expect(built).toBeVisible({ timeout: 30_000 });
  await built.click();
  const view = page.locator("[data-panel] [data-workflow-view]").first();
  await expect(view).toBeVisible();
  await expect(view.locator("[data-workflow-canvas]").first()).toBeVisible();
  await view.getByRole("tab", { name: "Versions" }).click();
  await expect(view.locator("[data-versions] li").first()).toBeVisible();
  await view.getByRole("tab", { name: "Lineage" }).click();
  await expect(view.locator("[data-lineage]")).toContainText(/iris|dataset/i);
  await page.screenshot({ path: "test-results/core-loop.png", fullPage: true });
});

// A result saved as a dataset version from the run's page names, in its lineage, the workflow
// version and the run that produced it. The run itself is made through the API: no model needed.
test("a result saved from its run shows that run in its lineage", async ({ page, request }) => {
  const form = { grant_type: "password", client_id: "texera-app", username: USER, password: PASSWORD };
  const tokenResponse = await request.post("/auth/realms/texera/protocol/openid-connect/token", { form });
  expect(tokenResponse.ok()).toBeTruthy();
  const token = (await tokenResponse.json()).access_token as string;
  const call = async (method: string, path: string, data?: unknown, contentType = "application/json") => {
    const r = await request.fetch(path, { method, data, headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType } });
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };

  const ds = await call("POST", "/catalog/v1/datasets", { name: `lineage e2e ${Date.now()}`, spec: { format: "csv" } });
  const dsRid = ds.metadata.rid as string;
  await call("PUT", `/catalog/v1/datasets/${dsRid}/files/flowers.csv`, "species,petal\nsetosa,1.4\nvirginica,5.5\nsetosa,1.6\n",
    "application/octet-stream");
  await call("POST", `/catalog/v1/datasets/${dsRid}/commit`, { message: "flowers" });
  const content = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan",
        operatorProperties: { fileName: `dataset://${dsRid}@1/flowers.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "avg", operatorType: "Aggregate", viewResult: true,
        operatorProperties: { groupByKeys: ["species"], aggregations: [{ aggFunction: "average", attribute: "petal", "result attribute": "avg" }] } },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
  };
  const wf = await call("POST", "/catalog/v1/workflows/with-content", { name: "flower means", content });
  const wfRid = wf.workflow.metadata.rid as string;
  const run = await call("POST", `/catalog/v1/workflows/${wfRid}/executions`, { waitSeconds: 120 });
  expect(run.status).toBe("completed");

  await signIn(page);
  await page.goto(`/x/${run.eid}`);
  await page.locator("[data-save-result]").click();
  const saved = page.locator('[data-panel^="dataset:"] [data-dataset-view]');
  await expect(saved).toBeVisible();
  await saved.getByRole("tab", { name: "Lineage" }).click();
  const lineage = saved.locator("[data-lineage]");
  await expect(lineage).toContainText("produced by");
  await expect(lineage).toContainText(`run ${(run.eid as string).slice(0, 8)}`);
  await expect(lineage).toContainText("flower means");
});
