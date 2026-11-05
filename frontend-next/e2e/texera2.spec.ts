import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

// The core loop against the real stack: sign in through Keycloak as alice, start a chat with an
// agent template, attach a CSV (which becomes a dataset version) and see it as a card; switch
// agents through the switcher and /mode (the host handles both without a model); create and edit
// an agent template from its page; and read a saved result's lineage. The real-model scenarios
// run when the agent runtime has a key (TEXERA_E2E_SKIP_MODEL unset).

const USER = process.env.TEXERA_E2E_USER ?? "alice";
const PASSWORD = process.env.TEXERA_E2E_PASSWORD ?? "alice";
const IRIS_QUESTION =
  "Using my dataset named iris, what is the average petal length for each species? Build and run a Texera workflow to compute it, then report the numbers.";

async function signIn(page: Page, user = USER, password = PASSWORD) {
  await page.goto("/");
  await page.locator("[data-sign-in]").first().click();
  // Keycloak's login form.
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.locator("[data-new-chat]")).toBeVisible();
}

async function startChat(page: Page, template: string) {
  await page.locator(`[data-template="${template}"]`).click();
  await page.locator("[data-start-chat]").click();
  await expect(page).toHaveURL(/\/conversations\//);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await expect(page.locator("[data-current-template]")).toHaveText(template);
}

async function say(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Send message").click();
}

/** A token and a JSON caller for the API, as the smoke tests use it. */
async function api(request: APIRequestContext, user = USER, password = PASSWORD) {
  const form = { grant_type: "password", client_id: "texera-app", username: user, password };
  const tokenResponse = await request.post("/auth/realms/texera/protocol/openid-connect/token", { form });
  expect(tokenResponse.ok()).toBeTruthy();
  const token = (await tokenResponse.json()).access_token as string;
  return async (method: string, path: string, data?: unknown, contentType = "application/json") => {
    const r = await request.fetch(`/catalog/v1${path}`, { method, data, headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType } });
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
}

test("signs in, starts a chat with an agent template and attaches a CSV that becomes a dataset", async ({ page }) => {
  await signIn(page);
  await startChat(page, "Data Analyst");

  // Attach a CSV and send: the upload makes a dataset version before the agent is asked.
  await page.locator("[data-attach-input]").setInputFiles({
    name: "penguins.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("species,island,bill_length_mm\nAdelie,Torgersen,39.1\nGentoo,Biscoe,46.1\n"),
  });
  await say(page, "What is in this file?");
  await expect(page.locator('[data-resource-card="dataset"]').first()).toBeVisible();

  // The dataset opens beside the chat and shows its file, named by its URI.
  await page.locator('[data-resource-card="dataset"] [aria-label="Open beside"]').first().click();
  const view = page.locator('[data-side-panel] [data-resource-view="dataset"]');
  await expect(view).toBeVisible();
  await expect(view.locator('[data-file="penguins.csv"]')).toBeVisible();
  await expect(view.locator("[data-file-uri]")).toContainText(/texera:\/\/datasets\/.+@1\/files\/penguins\.csv/);
  await expect(page).toHaveURL(/panel=datasets(%2F|\/)/);
  // The link carries the panel: reloading it brings the same view back.
  await page.reload();
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();
  await expect(page.locator('[data-side-panel] [data-file="penguins.csv"]')).toBeVisible();
  await page.screenshot({ path: "test-results/chat-with-dataset.png", fullPage: true });
});

test("switches agents through the switcher and through /mode, without a model", async ({ page }) => {
  await signIn(page);
  await startChat(page, "Data Analyst");

  await page.locator("[data-template-switcher]").click();
  await page.locator('[data-switch-to="Bio Researcher"]').click();
  await expect(page.locator("[data-current-template]")).toHaveText("Bio Researcher", { timeout: 30_000 });
  await expect(page.locator('[data-part="handoff"][data-handoff-by="person"]').first()).toBeVisible();

  await say(page, "/mode Data Analyst");
  await expect(page.locator("[data-current-template]")).toHaveText("Data Analyst", { timeout: 30_000 });
  await expect(page.locator('[data-part="handoff"]')).toHaveCount(2);
  await page.screenshot({ path: "test-results/switcher.png", fullPage: true });
});

test("lists the library, creates an agent template from its page, edits it into a second version and offers it to a new chat", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-library-link="agent-template"]').click();
  await expect(page.locator('[data-library="agent-template"]')).toBeVisible();
  await expect(page.locator('[data-resource-row="agent-template"]').filter({ hasText: "Bio Researcher" })).toBeVisible();

  await page.locator('[data-new="agent-template"]').click();
  const name = `E2E template ${Date.now()}`;
  await page.locator('[data-new-resource="agent-template"] input').first().fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/agent-templates\//);
  const form = page.locator("[data-template-form]");
  await expect(form).toBeVisible();
  await expect(form.locator('[data-field="model"]')).not.toHaveValue("");

  await form.locator('[data-field="prompt"]').fill("You are a careful analyst. Answer briefly.");
  await form.locator("[data-save-template]").click();
  await expect(form.locator("[data-save-template]")).toBeDisabled();
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.locator("[data-versions] li")).toHaveCount(2);
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page.locator("[data-grants]")).toBeVisible();
  // Sharing finds people in the directory whether or not they have logged in.
  await page.getByLabel("Principal").fill("bob");
  await page.locator('[data-principal="Bob Builder"]').click();
  await page.locator("[data-grant-button]").click();
  await expect(page.locator('[data-grant="viewer"]').filter({ hasText: "Bob Builder" })).toBeVisible();
  await page.screenshot({ path: "test-results/template-page.png", fullPage: true });

  await page.locator("[data-new-chat-link]").click();
  await expect(page.locator(`[data-template="${name}"]`)).toBeVisible();
});

test("creates a custom operator from its page and finds it in a workflow's palette", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-library-link="operator"]').click();
  await expect(page.locator('[data-library="operator"]')).toBeVisible();
  await page.locator('[data-new="operator"]').click();
  const name = `E2E rank ${Date.now()}`;
  await page.locator('[data-new-resource="operator"] input').first().fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/operators\//);
  const form = page.locator("[data-spec-editor='operator']");
  await expect(form.locator('[data-field="operatorType"]')).toHaveValue(name.replace(/[^A-Za-z0-9]+/g, ""));
  await expect(form.locator('[data-field="code"]')).toContainText("ProcessTupleOperator");
  // A property marked format: credential becomes a credential picker in the workflow editor.
  await form
    .locator('[data-field="propertiesSchema"]')
    .fill(JSON.stringify({ type: "object", properties: { apiKey: { type: "string", format: "credential", description: "The service key" } } }));
  await form.locator("[data-save-spec]").click();
  await expect(form.locator("[data-save-spec]")).toBeDisabled();

  // The operator is in the palette of a new workflow, typed by its URI.
  await page.locator('[data-library-link="workflow"]').click();
  await page.locator('[data-new="workflow"]').click();
  await page.locator('[data-new-resource="workflow"] input').first().fill(`E2E workflow ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("[data-workflow-view] [data-workflow-canvas]")).toBeVisible();
  const palette = page.locator("[data-operator-palette]");
  await palette.getByPlaceholder("Search operators").fill("E2E rank");
  const entry = palette.locator('[data-palette-operator^="texera://operators/"]').filter({ hasText: name });
  await expect(entry).toBeVisible();
  await entry.click();
  const properties = page.locator("[data-property-panel]");
  await expect(properties).toBeVisible();
  await expect(properties.locator("[data-credential-picker]")).toBeVisible();
  await page.screenshot({ path: "test-results/custom-operator.png", fullPage: true });
});

test("a run shows the file it read in its lineage, and can be kept past the retention policy", async ({ page, request }) => {
  const call = await api(request);
  const ds = await call("POST", "/datasets", { name: `lineage e2e ${Date.now()}`, spec: { format: "csv" } });
  const dsRid = ds.metadata.rid as string;
  await call("PUT", `/datasets/${dsRid}/files/flowers.csv`, "species,petal\nsetosa,1.4\nvirginica,5.5\nsetosa,1.6\n", "application/octet-stream");
  await call("POST", `/datasets/${dsRid}/commit`, { message: "flowers" });
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${dsRid}@1/files/flowers.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["species"], aggregations: [{ aggFunction: "average", attribute: "petal", "result attribute": "avg" }] } },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
  };
  const stamp = Date.now();
  const wf = await call("POST", "/workflows", { name: `flower means ${stamp}`, spec });
  const wfRid = wf.metadata.rid as string;
  const run = await call("POST", `/workflows/${wfRid}/run`, { waitSeconds: 180, name: `flower means run ${stamp}` });
  expect(run.status.phase).toBe("completed");
  const eid = run.metadata.rid as string;

  await signIn(page);
  await page.goto(`/workflows/${wfRid}/executions/${eid}`);
  const execution = page.locator("[data-execution-view]");
  await expect(execution).toBeVisible();
  await expect(execution.locator("[data-phase]")).toHaveText("completed");
  await expect(execution.locator("[data-port-rows]")).toBeVisible();
  await execution.getByRole("tab", { name: "Lineage" }).click();
  const lineage = execution.locator("[data-lineage]");
  await expect(lineage.locator('[data-edge="used"]')).toBeVisible();
  await expect(lineage).toContainText("flowers.csv");
  await execution.locator('[data-keep-run="free"]').click();
  await expect(execution.locator('[data-keep-run="kept"]')).toBeVisible();
  await page.screenshot({ path: "test-results/lineage.png", fullPage: true });

  // The workflow page lists the run and walks its own lineage to the file it read.
  await page.goto(`/workflows/${wfRid}`);
  const workflow = page.locator("[data-workflow-view]");
  await expect(workflow.locator("[data-workflow-canvas]")).toBeVisible();
  await workflow.getByRole("tab", { name: /^Runs/ }).click();
  await expect(workflow.locator('[data-run-row="completed"]').first()).toBeVisible();
});

test("two people in one chat: a shared conversation shows the other's messages and turn as they happen", async ({ browser, page, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob", "bob");
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  const alicePid = (await alice("GET", "/me")).principal.pid as string;

  await signIn(page);
  await startChat(page, "Data Analyst");
  const rid = page.url().split("/conversations/")[1]?.split(/[/?#]/)[0] as string;
  expect(rid).toBeTruthy();
  // Sharing is membership: bob, an editor, opens the same chat in his own browser.
  await alice("PUT", `/resources/${rid}/grants/${bobPid}`, { relation: "editor" });
  const bobsBrowser = await browser.newContext();
  const bobsPage = await bobsBrowser.newPage();
  await signIn(bobsPage, "bob", "bob");
  await bobsPage.goto(`/conversations/${rid}`);
  await expect(bobsPage.locator("[data-composer]")).toBeVisible();

  // Bob's message lands on alice's page without a reload, under his name.
  await bob("POST", `/conversations/${rid}/messages`, { role: "user", parts: [{ type: "text", text: "Hello from Bob" }] });
  const fromBob = page.locator('[data-message-role="user"]', { hasText: "Hello from Bob" });
  await expect(fromBob).toBeVisible();
  await expect(fromBob.locator(`[data-message-author="${bobPid}"]`)).not.toBeEmpty();
  // And alice's on bob's, under hers; one's own messages carry no label.
  await alice("POST", `/conversations/${rid}/messages`, { role: "user", parts: [{ type: "text", text: "Hi Bob, welcome" }] });
  const fromAlice = bobsPage.locator('[data-message-role="user"]', { hasText: "Hi Bob, welcome" });
  await expect(fromAlice).toBeVisible();
  await expect(fromAlice.locator(`[data-message-author="${alicePid}"]`)).not.toBeEmpty();
  await expect(page.locator(`[data-message-author="${alicePid}"]`)).toHaveCount(0);

  // While bob's turn runs, alice sees whose turn it is and waits; when it ends she may speak.
  const turn = await bob("POST", `/conversations/${rid}/turns`, {});
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toBeVisible();
  await expect(page.getByLabel("Send message")).toBeDisabled();
  await page.screenshot({ path: "test-results/group-chat.png", fullPage: true });
  await bob("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toHaveCount(0);
  await bobsBrowser.close();
});

test("a run page follows the run as it goes, and pauses and resumes it", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const ds = await call("POST", "/datasets", { name: `slow e2e ${stamp}`, spec: { format: "csv" } });
  const dsRid = ds.metadata.rid as string;
  const rows = Array.from({ length: 150 }, (_, i) => `${i},${(i % 7) * 1.5}`).join("\n");
  await call("PUT", `/datasets/${dsRid}/files/numbers.csv`, `id,value\n${rows}\n`, "application/octet-stream");
  await call("POST", `/datasets/${dsRid}/commit`, { message: "numbers" });
  const code = "from pytexera import *\nimport time\n\n\nclass ProcessTupleOperator(UDFOperatorV2):\n    @overrides\n    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:\n        time.sleep(0.2)\n        yield tuple_\n";
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${dsRid}@1/files/numbers.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "slow", operatorType: "PythonUDFV2", viewResult: true, operatorProperties: { code, workers: 1, retainInputColumns: true, outputColumns: [] } },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "slow", portID: "input-0" } }],
  };
  const wf = await call("POST", "/workflows", { name: `slow numbers ${stamp}`, spec });
  const wfRid = wf.metadata.rid as string;

  await signIn(page);
  const run = await call("POST", `/workflows/${wfRid}/run`, { name: `slow run ${stamp}` });
  await page.goto(`/workflows/${wfRid}/executions/${run.metadata.rid}`);
  const execution = page.locator("[data-execution-view]");
  await expect(execution.locator("[data-phase]")).toHaveText("running", { timeout: 90_000 });
  // The operators tab fills in as the unit reports progress, with no reload.
  await execution.getByRole("tab", { name: "Operators" }).click();
  await expect(execution.getByRole("cell", { name: "slow" })).toBeVisible({ timeout: 30_000 });
  await execution.locator("[data-pause-run]").click();
  await expect(execution.locator("[data-phase]")).toHaveText("paused", { timeout: 30_000 });
  await page.screenshot({ path: "test-results/paused-run.png", fullPage: true });
  await execution.locator("[data-resume-run]").click();
  await expect(execution.locator("[data-phase]")).toHaveText("running", { timeout: 30_000 });
  await expect(execution.locator("[data-phase]")).toHaveText("completed", { timeout: 90_000 });
  await execution.getByRole("tab", { name: /^Results/ }).click();
  await expect(execution.locator("[data-port-rows]")).toBeVisible();
});

// The core loop with the real model: bob asks the Data Analyst about his iris dataset; the agent
// builds and runs a workflow through the dataflow MCP server; the answer arrives, and the
// workflow it built is listed as a resource of this chat and opens beside it.
test("a Data Analyst chat answers from a workflow it built and the chat tracks it", async ({ page }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(300_000);
  await signIn(page, "bob", "bob");
  await startChat(page, "Data Analyst");
  await say(page, IRIS_QUESTION);

  const answer = page.locator('[data-message-role="assistant"]').last();
  // The averages, as the model may round them: 1.462, 4.260 and 5.552.
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await expect(answer).toContainText(/5\.55/);
  await expect(page.locator('[data-message-template="Data Analyst"]').first()).toBeVisible();

  const built = page.locator('[data-rail-item="workflow"]').first();
  await expect(built).toBeVisible({ timeout: 30_000 });
  await built.click();
  const view = page.locator("[data-side-panel] [data-workflow-view]").first();
  await expect(view).toBeVisible();
  await expect(view.locator("[data-workflow-canvas]").first()).toBeVisible();
  await view.getByRole("tab", { name: "Versions" }).click();
  await expect(view.locator("[data-versions] li").first()).toBeVisible();
  await view.getByRole("tab", { name: "Lineage" }).click();
  await expect(view.locator("[data-lineage]")).toContainText(/iris/i);
  await page.screenshot({ path: "test-results/core-loop.png", fullPage: true });
});

// The M1 scenario: alice starts with the Bio Researcher, gets cited research ideas, then asks for
// an analysis; the Bio Researcher hands the chat to the Data Analyst, which answers from a run.
test("the Bio Researcher hands the chat to the Data Analyst for the analysis, which then shares the data", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(420_000);
  await signIn(page);
  await startChat(page, "Bio Researcher");
  await say(page, "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.");
  const ideas = page.locator('[data-message-role="assistant"]').last();
  await expect(ideas).toContainText(/off-target/i, { timeout: 180_000 });
  await expect(page.locator('[data-message-template="Bio Researcher"]').first()).toBeVisible();
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 60_000 });

  await say(page, "Now analyze the iris dataset in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.");
  await expect(page.locator('[data-part="handoff"][data-handoff-to="Data Analyst"]')).toBeVisible({ timeout: 240_000 });
  const answer = page.locator('[data-message-role="assistant"]').last();
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await expect(page.locator("[data-current-template]")).toHaveText("Data Analyst");
  await expect(page.locator('[data-message-template="Data Analyst"]').first()).toBeVisible();
  await page.screenshot({ path: "test-results/handoff.png", fullPage: true });

  // The active agent shares through the catalog server: afterwards bob can read alice's iris.
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 60_000 });
  await say(page, "Share my iris dataset with Bob so he can read it.");
  await expect(page.locator('[data-tool="grant_access"][data-tool-state="done"]').first()).toBeVisible({ timeout: 180_000 });
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 60_000 });
  const asBob = await api(request, "bob", "bob");
  const bob = await asBob("GET", "/me");
  const visible = await asBob("GET", "/datasets?q=iris");
  expect(visible.items.some((d: { metadata: { name: string; owner: string } }) => d.metadata.name === "iris" && d.metadata.owner !== bob.principal.pid)).toBe(true);
});
