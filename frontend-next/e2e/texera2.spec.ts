import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

// The pages against the real stack: sign in through Keycloak, start a chat with the deployment's
// one agent, attach a CSV (which becomes a dataset version) and see it as a card; a turn that
// fails and says why; a long answer that ends up on screen; custom operators; a run's lineage;
// two people in one chat; a run that is paused and resumed. The real-model scenarios run when
// the agent runtime has a key (TEXERA_E2E_SKIP_MODEL unset).

const USER = process.env.TEXERA_E2E_USER ?? "alice";
const PASSWORD = process.env.TEXERA_E2E_PASSWORD ?? "alice";
const IRIS_QUESTION =
  "Using my dataset named iris, what is the average petal length for each species? Build and run a Texera workflow to compute it, then report the numbers.";
// The flowers the model scenarios ask about. Each scenario makes its own copy and removes it.
const IRIS_CSV = readFileSync(fileURLToPath(new URL("../../bin/texera-2-0/examples/iris.csv", import.meta.url)));

// What a scenario must put back, run after it whether it passed or not.
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function signIn(page: Page, user = USER, password = PASSWORD) {
  await page.goto("/");
  await page.locator("[data-sign-in]").first().click();
  // Keycloak's login form.
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.locator("[data-new-chat]")).toBeVisible();
}

const AGENT = "Texera Agent";

/** Starts a chat from the home page: there is one agent, so the only choice is the computing unit. */
async function startChat(page: Page, unit?: string) {
  if (unit) {
    await page.getByLabel("Computing unit").click();
    await page.getByRole("option", { name: unit, exact: true }).click();
  }
  await page.locator("[data-start-chat]").click();
  await expect(page).toHaveURL(/\/conversations\//);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await expect(page.locator("[data-current-template]")).toHaveText(AGENT);
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
  const send = (method: string, path: string, data?: unknown, contentType = "application/json") =>
    request.fetch(`/catalog/v1${path}`, { method, data, headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType } });
  const call = async (method: string, path: string, data?: unknown, contentType = "application/json") => {
    const r = await send(method, path, data, contentType);
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  /** Best effort, for tidying up: a refusal is reported, not fatal. */
  const attempt = async (method: string, path: string, data?: unknown) => {
    const r = await send(method, path, data);
    if (!r.ok()) console.warn(`${method} ${path}: ${r.status()} ${await r.text()}`);
  };
  return Object.assign(call, { attempt });
}
type Caller = Awaited<ReturnType<typeof api>>;

/** The conversation the page shows, from its URL. */
function conversationOf(page: Page): string {
  const rid = /\/conversations\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  expect(rid, `a conversation in ${page.url()}`).toBeDefined();
  return rid as string;
}

type Made = { kind: string; metadata: { rid: string; parent?: string }; status?: { phase?: string } };

/**
 * A project of the person's for one scenario, with their iris dataset in it, as the pytest
 * scenarios have. `clear` removes what the chat made (an agent's workflow lands in the person's
 * home project unless the tool names a parent), then the project with the dataset.
 */
async function withIris(as: Caller, label: string) {
  const project = (await as("POST", "/projects", { name: `${label} ${Date.now()}`, spec: {} })).metadata.rid as string;
  const dataset = (await as("POST", "/datasets", { name: "iris", spec: { format: "csv" }, parent: project })).metadata.rid as string;
  await as("PUT", `/datasets/${dataset}/files/iris.csv`, IRIS_CSV, "text/csv");
  await as("POST", `/datasets/${dataset}/commit`, { message: "Fisher's iris flowers" });
  const removeRun = async (workflow: string, eid: string, phase?: string) => {
    if (phase && !["completed", "failed", "cancelled"].includes(phase)) await as.attempt("POST", `/workflows/${workflow}/executions/${eid}/cancel`, {});
    await as.attempt("DELETE", `/workflows/${workflow}/executions/${eid}`);
  };
  const clear = async (conversation?: string, others: string[] = []) => {
    const made: Made[] = conversation ? await as("GET", `/conversations/${conversation}/resources`) : [];
    for (const r of made) if (r.kind === "execution" && r.metadata.parent) await removeRun(r.metadata.parent, r.metadata.rid, r.status?.phase);
    for (const r of made) {
      if (r.kind !== "workflow") continue;
      const runs: { items: Made[] } = await as("GET", `/workflows/${r.metadata.rid}/executions?limit=500`);
      for (const ex of runs.items) await removeRun(r.metadata.rid, ex.metadata.rid, ex.status?.phase);
    }
    for (const kind of ["workflow", "dataset"]) for (const r of made) if (r.kind === kind) await as.attempt("DELETE", `/resources/${r.metadata.rid}`);
    if (conversation) await as.attempt("DELETE", `/resources/${conversation}`);
    for (const rid of others) await as.attempt("DELETE", `/resources/${rid}`);
    await as.attempt("DELETE", `/resources/${dataset}`);
    await as.attempt("DELETE", `/projects/${project}`);
  };
  return { project, dataset, clear };
}

test("signs in, starts a chat and attaches a CSV that becomes a dataset", async ({ page }) => {
  await signIn(page);
  // One agent is the entry to every chat: nothing to pick, no agents to manage.
  await expect(page.locator("[data-template-picker]")).toHaveCount(0);
  await expect(page.locator('[data-library-link="agent-template"]')).toHaveCount(0);
  await startChat(page);
  await expect(page.locator("[data-template-switcher]")).toHaveCount(0);

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
  // What was attached stays a card of the person's message and a resource of the chat, with no URI among their words.
  const mine = page.locator('[data-message-role="user"]').first();
  await expect(mine.locator('[data-resource-card="dataset"]')).toBeVisible();
  await expect(mine).toContainText("What is in this file?");
  await expect(mine.getByText("texera://")).toHaveCount(0);
  await expect(page.locator('[data-rail-item="dataset"]').first()).toBeVisible();
  await page.screenshot({ path: "test-results/chat-with-dataset.png", fullPage: true });
});

// A turn that cannot start, for real: the agent's model endpoint names a credential that holds no
// key, so the agent cannot be built and no model is called. The person must see why, and keep
// seeing it. (Custom agents have no page for now; the API still makes one.)
test("a turn that fails says why, and the chat keeps saying it", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const credential = await call("POST", "/credentials", { name: `no key ${stamp}`, spec: { kind: "api_key", scope: "nowhere" } });
  const endpoint = await call("POST", "/model-endpoints", { name: `no key ${stamp}`, spec: { provider: "anthropic", model: "claude-haiku-5-5", credential: credential.metadata.uri } });
  const name = `Keyless ${stamp}`;
  const template = await call("POST", "/agent-templates", {
    name,
    spec: { card: { name, description: "Its model has no key" }, model: endpoint.metadata.uri, prompt: "Answer.", catalogTools: false },
  });
  const conversation = await call("POST", "/conversations", { name: `keyless chat ${stamp}`, spec: { template: template.metadata.uri } });
  cleanups.push(async () => {
    for (const r of [conversation, template, endpoint, credential]) await call.attempt("DELETE", `/resources/${r.metadata.rid}`);
  });

  await signIn(page);
  await page.goto(`/conversations/${conversation.metadata.rid}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await say(page, "Hello?");
  const error = page.locator('[data-part="error"]');
  await expect(error).toBeVisible({ timeout: 30_000 });
  const reason = await error.innerText();
  expect(reason.trim()).not.toBe("");
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible();
  // It is still there once the catalog's copy of the turn has replaced the live one, and after a reload.
  await page.waitForTimeout(1500);
  await expect(error).toHaveCount(1);
  await expect(error).toHaveText(reason);
  await page.reload();
  await expect(page.locator('[data-message-role="user"]', { hasText: "Hello?" })).toBeVisible();
  await expect(page.locator('[data-part="error"]')).toHaveText(reason);
  await page.screenshot({ path: "test-results/failed-turn.png", fullPage: true });
});

// The runtime's part of a turn, without a model: the messages in the catalog, then the stream.
test("a long first answer ends up on screen", async ({ page, request }) => {
  await signIn(page);
  await startChat(page);
  const rid = conversationOf(page);
  const call = await api(request);
  cleanups.push(() => call.attempt("DELETE", `/resources/${rid}`));
  const answer = `${Array.from({ length: 90 }, (_, i) => `Paragraph ${i} of a long answer.`).join("\n\n")}\n\nThe end of the answer.`;
  await page.route(`**/agents/conversations/${rid}/ag-ui`, async route => {
    const events = [
      { type: "RUN_STARTED", threadId: rid, runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: answer },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: rid, runId: "r" },
    ];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") });
    // The catalog gets the turn while the page shows the stream, as from the runtime.
    const turn = await call("POST", `/conversations/${rid}/turns`, {});
    await call("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "user", parts: [{ type: "text", text: "Tell me everything." }] });
    await call("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "assistant", template: turn.template, parts: [{ type: "text", text: answer }] });
    await call("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
  });
  await say(page, "Tell me everything.");
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible();
  // One copy: the catalog's has replaced the live one.
  const end = page.getByText("The end of the answer.");
  await expect(end).toHaveCount(1);
  await expect(end).toBeInViewport();
  // Someone who scrolled up to read is left where they are.
  const scroller = page.locator('[data-message-role="assistant"]').first().locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]");
  await scroller.evaluate(el => {
    el.scrollTop = 0;
  });
  await expect(page.getByText("Paragraph 0 of a long answer.")).toBeInViewport();
  await page.waitForTimeout(500);
  await expect(page.getByText("Paragraph 0 of a long answer.")).toBeInViewport();
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
  // Every save is a version, and the page shares the resource with someone found in the
  // directory, whether or not they have logged in.
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.locator("[data-versions] li")).toHaveCount(2);
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page.locator("[data-grants]")).toBeVisible();
  await page.getByLabel("Principal").fill("bob");
  await page.locator('[data-principal="Bob Builder"]').click();
  await page.locator("[data-grant-button]").click();
  await expect(page.locator('[data-grant="viewer"]').filter({ hasText: "Bob Builder" })).toBeVisible();

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
  await startChat(page);
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

// The core loop with the real model: bob picks a computing unit of his own for the chat and asks
// about his iris dataset; the agent builds and runs a workflow through the dataflow server; the
// answer arrives on screen, the run went to the unit he picked without a word about it, and the
// workflow is listed as a resource of this chat and opens beside it.
test("the agent answers from a workflow it built, on the unit the chat names", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(300_000);
  const asBob = await api(request, "bob", "bob");
  const iris = await withIris(asBob, "core loop e2e");
  // A second unit at the deployment's engine, so the run's unit tells where the chat sent it.
  const units: Array<{ metadata: { uri: string }; spec: { provider: string; endpoint?: string; clientId?: string } }> = await asBob("GET", "/computing-units/available");
  const base = units.find(u => u.spec.provider === "static");
  expect(base, "the deployment's own unit").toBeDefined();
  const unitName = `bob's unit ${Date.now()}`;
  const unit = await asBob("POST", "/computing-units", { name: unitName, parent: iris.project, spec: { provider: "static", endpoint: base?.spec.endpoint, ...(base?.spec.clientId ? { clientId: base.spec.clientId } : {}) } });
  let conversation: string | undefined;
  cleanups.push(async () => {
    await iris.clear(conversation, [unit.metadata.rid]);
  });
  await signIn(page, "bob", "bob");
  await startChat(page, unitName);
  conversation = conversationOf(page);
  await say(page, IRIS_QUESTION);

  const answer = page.locator('[data-message-role="assistant"]').last();
  // The averages, as the model may round them: 1.462, 4.260 and 5.552.
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await expect(answer).toContainText(/5\.55/);
  await expect(page.locator(`[data-message-template="${AGENT}"]`).first()).toBeVisible();
  // The turn is over and the end of the answer is where the person is looking.
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 60_000 });
  await expect(answer.getByText(/5\.55/).last()).toBeInViewport();

  // Where it ran: the unit bob picked for the chat, though neither he nor the agent named it.
  const made: Made[] = await asBob("GET", `/conversations/${conversation}/resources`);
  const runs = made.filter(r => r.kind === "execution");
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect((run as unknown as { spec: { computingUnit: string } }).spec.computingUnit).toBe(unit.metadata.uri);

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

// One agent for everything: alice asks for research ideas, which the agent grounds with the bio
// tools; then for an analysis of her data, which the same agent answers from a run, with no
// handoff; then to share the data, which it does through the catalog server.
test("one agent researches, analyzes and shares in one chat", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(420_000);
  const iris = await withIris(await api(request), "one agent e2e");
  let conversation: string | undefined;
  cleanups.push(() => iris.clear(conversation));
  await signIn(page);
  await startChat(page);
  conversation = conversationOf(page);
  const turnOver = () => expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 240_000 });

  await say(page, "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.");
  // It consults the literature tools before it answers, whatever they return today.
  await expect(page.locator('[data-tool="search_pubmed"]').first()).toBeVisible({ timeout: 180_000 });
  await turnOver();
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(/off-target/i);

  await say(page, "Now analyze the iris dataset in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.");
  const answer = page.locator('[data-message-role="assistant"]').last();
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await turnOver();
  // The same agent did both: the chat never changed hands.
  await expect(page.locator('[data-part="handoff"]')).toHaveCount(0);
  await expect(page.locator("[data-current-template]")).toHaveText(AGENT);
  await page.screenshot({ path: "test-results/one-agent.png", fullPage: true });

  // It shares through the catalog server: afterwards bob can read alice's iris.
  await say(page, "Share my iris dataset with Bob so he can read it.");
  await expect(page.locator('[data-tool="grant_access"][data-tool-state="done"]').first()).toBeVisible({ timeout: 180_000 });
  await turnOver();
  const asBob = await api(request, "bob", "bob");
  const bob = await asBob("GET", "/me");
  const visible = await asBob("GET", "/datasets?q=iris");
  expect(visible.items.some((d: { metadata: { name: string; owner: string } }) => d.metadata.name === "iris" && d.metadata.owner !== bob.principal.pid)).toBe(true);
});
