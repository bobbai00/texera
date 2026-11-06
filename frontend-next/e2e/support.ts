// What every browser scenario shares: signing in through Keycloak, the chat box, a caller for
// the API, and the tidying up a scenario owes the stack it ran against.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const USER = process.env.TEXERA_E2E_USER ?? "alice";
export const PASSWORD = process.env.TEXERA_E2E_PASSWORD ?? "alice";
export const IRIS_QUESTION =
  "Using my dataset named iris, what is the average petal length for each species? Build and run a Texera workflow to compute it, then report the numbers.";
// The flowers the model scenarios ask about. Each scenario makes its own copy and removes it.
export const IRIS_CSV = readFileSync(fileURLToPath(new URL("../../bin/texera-2-0/examples/iris.csv", import.meta.url)));

// What a scenario must put back, run after it whether it passed or not, last made first: a
// chat goes before the model it chose.
export const cleanups: Array<() => Promise<void>> = [];
/** Runs what the scenario left to put back; a spec registers it with `test.afterEach(tidyUp)`. */
export async function tidyUp() {
  for (const clean of cleanups.splice(0).reverse()) await clean();
}

export async function signIn(page: Page, user = USER, password = PASSWORD) {
  await page.goto("/");
  await page.locator("[data-sign-in]").first().click();
  // Keycloak's login form.
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.locator("[data-new-chat]")).toBeVisible();
}

export const AGENT = "Texera Agent";

export async function say(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Send message").click();
}

/** Starts a chat from the home page by saying something: the first message makes the chat. */
export async function ask(page: Page, text: string) {
  await expect(page.locator("[data-new-chat]")).toBeVisible();
  await say(page, text);
  await expect(page).toHaveURL(/\/conversations\//);
  await expect(page.locator("[data-current-template]")).toHaveText(AGENT);
}

/** Picks one of a select's options by its name. */
export async function pick(page: Page, select: ReturnType<Page["locator"]>, option: string | RegExp) {
  await select.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Picks the project the person works in, in the sidebar. */
export const workIn = (page: Page, project: string) => pick(page, page.getByLabel("Project", { exact: true }), project);

/** A token and a JSON caller for the API, as the smoke tests use it. */
export async function api(request: APIRequestContext, user = USER, password = PASSWORD) {
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
export type Caller = Awaited<ReturnType<typeof api>>;

/** A chat made through the API and opened, for a scenario that needs the chat before a word is said. */
export async function openChat(page: Page, as: Caller, name: string, spec: Record<string, unknown> = {}) {
  const conversation = await as("POST", "/conversations", { name, spec });
  const rid = conversation.metadata.rid as string;
  cleanups.push(() => as.attempt("DELETE", `/resources/${rid}`));
  await page.goto(`/conversations/${rid}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
  return rid;
}

/** Puts the person back in their own project: the pick is a preference and outlives a test. */
export async function workAtHome(as: Caller) {
  const { project: _, ...preferences } = (await as("GET", "/me")).preferences as Record<string, unknown>;
  await as("PUT", "/me/preferences", preferences);
}

/** The conversation the page shows, from its URL. */
export function conversationOf(page: Page): string {
  const rid = /\/conversations\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  expect(rid, `a conversation in ${page.url()}`).toBeDefined();
  return rid as string;
}

export type Made = { kind: string; metadata: { rid: string; parent?: string }; status?: { phase?: string } };

/** Removes workflows with their executions, then other resources: what a scenario made in the person's own project. */
export async function discard(as: Caller, workflows: string[], others: string[] = []) {
  for (const workflow of workflows) {
    const executions: { items: Made[] } = await as("GET", `/workflows/${workflow}/executions?limit=500`);
    for (const execution of executions.items) {
      const path = `/workflows/${workflow}/executions/${execution.metadata.rid}`;
      if (!["completed", "failed", "cancelled"].includes(execution.status?.phase ?? "")) await as.attempt("POST", `${path}/cancel`, {});
      await as.attempt("DELETE", path);
    }
    await as.attempt("DELETE", `/resources/${workflow}`);
  }
  for (const rid of others) await as.attempt("DELETE", `/resources/${rid}`);
}

/**
 * A project of the person's for one scenario, with their iris dataset in it, as the pytest
 * scenarios have. The scenario works in it, so the agent finds the data there and makes what it
 * makes there. `clear` removes what the chat made, then the project with the dataset, and puts
 * the person back in their own project.
 */
export async function withIris(as: Caller, label: string) {
  const name = `${label} ${Date.now()}`;
  const project = (await as("POST", "/projects", { name, spec: {} })).metadata.rid as string;
  const dataset = (await as("POST", "/datasets", { name: "iris", spec: { format: "csv" }, parent: project })).metadata.rid as string;
  await as("PUT", `/datasets/${dataset}/files/iris.csv`, IRIS_CSV, "text/csv");
  await as("POST", `/datasets/${dataset}/commit`, { message: "Fisher's iris flowers" });
  const removeExecution = async (workflow: string, eid: string, phase?: string) => {
    if (phase && !["completed", "failed", "cancelled"].includes(phase)) await as.attempt("POST", `/workflows/${workflow}/executions/${eid}/cancel`, {});
    await as.attempt("DELETE", `/workflows/${workflow}/executions/${eid}`);
  };
  const clear = async (conversation?: string, others: string[] = []) => {
    const made: Made[] = conversation ? await as("GET", `/conversations/${conversation}/resources`) : [];
    for (const r of made) if (r.kind === "execution" && r.metadata.parent) await removeExecution(r.metadata.parent, r.metadata.rid, r.status?.phase);
    for (const r of made) {
      if (r.kind !== "workflow") continue;
      const executions: { items: Made[] } = await as("GET", `/workflows/${r.metadata.rid}/executions?limit=500`);
      for (const ex of executions.items) await removeExecution(r.metadata.rid, ex.metadata.rid, ex.status?.phase);
    }
    for (const kind of ["workflow", "dataset"]) for (const r of made) if (r.kind === kind) await as.attempt("DELETE", `/resources/${r.metadata.rid}`);
    if (conversation) await as.attempt("DELETE", `/resources/${conversation}`);
    for (const rid of others) await as.attempt("DELETE", `/resources/${rid}`);
    await as.attempt("DELETE", `/resources/${dataset}`);
    await as.attempt("DELETE", `/projects/${project}`);
    await workAtHome(as);
  };
  return { project, name, dataset, clear };
}

export interface PageOf {
  kind: string;
  /** The page's address. */
  path: string;
  /** The URI the agent is told. */
  uri: string;
  name: string;
  /** Whether the scenario made it in its own project: a chat about it goes there. */
  mine: boolean;
}

export type Envelope = { kind: string; metadata: { rid: string; uri: string; name: string; project: string; parent?: string } };

/** A page of every kind that has one: made in a project of the scenario's, or the platform's own. */
export async function aPageOfEveryKind(as: Caller): Promise<{ pages: PageOf[]; project: string }> {
  const stamp = Date.now();
  const project: Envelope = await as("POST", "/projects", { name: `dock pages ${stamp}`, spec: {} });
  const P = project.metadata.rid;
  const made: Envelope[] = [];
  const make = async (plural: string, name: string, spec: unknown) => {
    const r: Envelope = await as("POST", `/${plural}`, { name, parent: P, spec });
    made.push(r);
    return r;
  };
  const dataset = await make("datasets", "iris", { format: "csv" });
  await as("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await as("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "Fisher's iris flowers" });
  const workflow = await make("workflows", "mean petals", {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
  });
  const execution: Envelope = await as("POST", `/workflows/${workflow.metadata.rid}/run`, { waitSeconds: 180, name: "mean petals, once" });
  await make("models", "a model", {});
  await make("environments", "an environment", { python: { packages: [] } });
  await make("credentials", "a key", { kind: "api_key" });
  await make("warehouses", "a warehouse", {});
  await make("model-endpoints", "an endpoint", { provider: "anthropic", model: "claude-haiku-5-5" });
  await make("skills", "a-skill", { name: "a-skill", description: "What it is for", body: "How to do it." });
  cleanups.push(async () => {
    await discard(as, [workflow.metadata.rid], made.filter(r => r.kind !== "workflow").map(r => r.metadata.rid));
    await as.attempt("DELETE", `/projects/${P}`);
  });

  // What the platform ships, for the kinds a person does not make in a moment.
  const platform = (await as("GET", "/me")).systemProject as string;
  const builtIn: Envelope[] = [];
  for (const plural of ["operators", "computing-units", "mcp-servers", "agent-templates"]) {
    const { items } = (await as("GET", `/${plural}?scope=${platform}&limit=5`)) as { items: Envelope[] };
    expect(items.length, `a built-in of ${plural}`).toBeGreaterThan(0);
    builtIn.push(items[0] as Envelope);
  }

  const pageOf = (r: Envelope, mine: boolean): PageOf => ({ kind: r.kind, path: `/${r.metadata.uri.replace("texera://", "")}`, uri: r.metadata.uri, name: r.metadata.name, mine });
  return { project: P, pages: [pageOf(project, true), ...made.map(r => pageOf(r, true)), pageOf(execution, true), ...builtIn.map(r => pageOf(r, false))] };
}
