import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, ask, type Caller, cleanups, conversationOf, operatorList, say, signIn, tidyUp } from "./support";

// The demo in the README of bin/texera-2-0/examples/diabetes, whole, through the real model and in
// two browsers. In one story Alice asks what models and data there are, picks one of each from the
// agent's cards, and has the agent build the inference on a unit she makes; she shares the chat,
// Bob opens it and takes part, and each sees what the other says and gets. In the other she lands
// on her project and brings a file, which stays the chat's; the agent says which model fits, runs
// it on the public unit, looks up what is published, and keeps the file. Then they open the
// workflow together, see each other's pointers, and what he adds appears on her canvas.

test.afterEach(tidyUp);

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = `${REPO}bin/texera-2-0/examples/diabetes`;
const DATA = process.env.TEXERA_DIABETES_DATA ?? join(homedir(), "texera-diabetes");
const FILE = join(DATA, "uploads", "screening_cohort.csv");

const CHECK = "Can you check what's in this data? I want to analyze it using the models in our project. Which model do you think works best? Please go ahead and run it.";
const LITERATURE = "How does that compare with what has been published on models like this? Cite what you find.";
const KEEP = "Please keep this file as a dataset called Screening cohort.";

const MODELS = "What models do we have for screening people for diabetes?";
const WHICH_DATA = "What data do we have on US adults that I could use one of them on?";
const BUILD = "Build a workflow that applies this model to this dataset. I want to know how many people it flags as high risk, and whether that agrees with their HbA1c.";
const BOB_ASKS = "What share of these people does it put above a 20% risk?";
const ALICE_NOTES = "Thanks Bob, that is the number I was after.";

/** What load.py made: a project of the test's own. */
function teamProject(): { rid: string } {
  const gw = process.env.TEXERA_BASE_URL ?? "http://localhost:8088";
  const name = `Diabetes research ${Date.now()}`;
  const out = execFileSync("python3", [`${EXAMPLE}/load.py`, "--data", DATA, "--gw", gw, "--project", name], { encoding: "utf8", timeout: 300_000 });
  return { rid: (out.trim().split("\n").at(-1) as string).split("/").at(-1) as string };
}

/** Another person's own browser, signed in. */
async function browserOf(browser: Browser, user: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, user);
  cleanups.push(() => context.close());
  return page;
}

/** Everything the project holds goes, then the project. */
async function emptied(as: Caller, project: string) {
  const items = ((await as("GET", `/resources?project=${project}&limit=500`)) as { items: { kind: string; metadata: { rid: string } }[] }).items;
  const of = (kind: string) => items.filter(r => r.kind === kind);
  for (const u of of("computing-unit")) await as.attempt("POST", `/computing-units/${u.metadata.rid}/terminate`, {});
  for (const w of of("workflow")) {
    const runs = (await as("GET", `/workflows/${w.metadata.rid}/executions?limit=50`)) as { items: { metadata: { rid: string } }[] };
    for (const e of runs.items) await as.attempt("DELETE", `/workflows/${w.metadata.rid}/executions/${e.metadata.rid}`);
  }
  // What the project's settings name cannot go while they do.
  await as.attempt("PUT", `/projects/${project}`, { spec: {} });
  for (const kind of ["workflow", "conversation", "dataset", "model", "operator", "computing-unit", "agent-template"])
    for (const r of of(kind)) await as.attempt("DELETE", `/resources/${r.metadata.rid}`);
  await as.attempt("DELETE", `/projects/${project}`);
}

/** Waits for a turn that has started to end: the composer offers to stop it, then to send again. */
async function turnEnds(page: Page) {
  await expect(page.getByLabel("Stop generating")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Stop generating")).toBeHidden({ timeout: 900_000 });
}

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/demo-${name}.png` });

/** Makes a project the one the person works in, as its page offers. */
async function workHere(page: Page, as: Caller, project: string) {
  await page.goto(`/projects/${project}`);
  await page.locator("[data-work-here]").click();
  await expect(page.locator("[data-working-here]")).toBeVisible();
  // The badge is the app following at once; the catalog keeps the pick a moment later.
  await expect.poll(async () => ((await as("GET", "/me")) as { preferences: { project?: string } }).preferences.project).toBe(project);
}

/** Two people open a workflow: they see each other, each other's pointers, and what the other adds. */
async function together(page: Page, bobs: Page, as: Caller, workflow: string, name: string) {
  await page.goto(`/workflows/${workflow}`);
  await bobs.goto(`/workflows/${workflow}`);
  await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "true", { timeout: 30_000 });
  await expect(bobs.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "true", { timeout: 30_000 });
  const present = (on: Page) => on.locator("[data-presence] [data-present]");
  await expect(present(page)).toHaveCount(2, { timeout: 15_000 });
  await expect(present(bobs)).toHaveCount(2, { timeout: 15_000 });

  // Each sees where the other points.
  const point = async (on: Page, dx: number) => {
    const box = (await on.locator("[data-workflow-canvas]").boundingBox()) as { x: number; y: number; width: number; height: number };
    // Near the top: the results of the execution float over the bottom of the canvas.
    await on.mouse.move(box.x + box.width / 2 + dx, box.y + 130, { steps: 5 });
  };
  await point(page, -80);
  await expect(bobs.locator('[data-cursor="Alice Liddell"]')).toBeVisible({ timeout: 10_000 });
  await point(bobs, 80);
  await expect(page.locator('[data-cursor="Bob Builder"]')).toBeVisible({ timeout: 10_000 });
  await shot(page, `${name}-each-others-pointers`);

  // What he adds appears on her canvas, with no reload, and goes into the next version.
  const before = await page.locator(".react-flow__node-operator").count();
  const palette = await operatorList(bobs);
  await palette.getByPlaceholder("Search operators").fill("Limit");
  await palette.locator('[data-palette-operator="Limit"]').click();
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(page.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  await bobs.locator("[data-operator-done]").click();
  await expect
    .poll(async () => ((await as("GET", `/workflows/${workflow}`)) as { spec: { operators: { operatorType: string }[] } }).spec.operators.some(o => o.operatorType === "Limit"), { timeout: 30_000 })
    .toBe(true);
  await shot(page, `${name}-edited-together`);
}

type Message = { role: string; parts: { type: string; toolName?: string; text?: string; args?: unknown }[] };
const messagesOf = async (as: Caller, chat: string) => ((await as("GET", `/conversations/${chat}/messages?limit=200`)) as { items: Message[] }).items;
const toolsOf = (messages: Message[]) => messages.flatMap(m => m.parts.filter(p => p.type === "tool_call").map(p => p.toolName));
/** What the agent said to the person last: its words, and the question it put to them. */
const answerOf = (messages: Message[]) =>
  (messages.at(-1) as Message).parts.flatMap(p => (p.type === "text" ? [p.text] : p.toolName === "ask" ? [JSON.stringify(p.args)] : [])).join("");

test("the demo: a project at a glance, a file brought to the chat and analyzed with the team's model, and two people on the workflow it made", async ({ page, browser, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.skip(!existsSync(FILE), `run prepare.py first: no ${FILE}`);
  test.setTimeout(2_400_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const alice = await api(request);
  const project = teamProject();
  cleanups.push(() => emptied(alice, project.rid));
  await signIn(page);
  await workHere(page, alice, project.rid);

  // Part 1: the new-chat page is the project's logo over four cards that roll through what it holds.
  await page.goto("/");
  const deck = page.locator(`[data-project-deck="${project.rid}"]`);
  await expect(deck.locator("[data-project-logo]")).toBeVisible();
  for (const kind of ["dataset", "model", "workflow", "conversation"])
    await expect(deck.locator(`[data-deck-card="${kind}"]`)).toBeVisible();
  await expect(deck.locator("[data-deck-card]")).toHaveCount(4);
  const model = deck.locator('[data-deck-card="model"] [data-deck-face]');
  const first = await model.innerText();
  await expect(model).toContainText("Owned by me");
  await expect.poll(() => model.innerText(), { timeout: 12_000 }).not.toBe(first);
  await expect(page.locator("[data-new-chat] [data-composer]")).toBeInViewport();
  // With a brand in the data folder, the project wears it.
  if (existsSync(`${DATA}/brand/brand.json`)) await expect(page.locator("[data-look]")).toHaveAttribute("data-look", "dkNET AI");
  await shot(page, "1-landing");

  // The project's own page has the whole list, by kind, each saying what it is.
  await page.goto(`/projects/${project.rid}`);
  const overview = page.locator(`[data-project-overview="${project.rid}"]`);
  for (const [kind, said] of [
    ["dataset", "View all 12"],
    ["model", "View all 15"],
    ["workflow", "View all 15"],
    ["operator", "ROC AUC"],
    ["computing-unit", "Public unit"],
  ] as const)
    await expect(overview.locator(`[data-overview-section="${kind}"]`)).toContainText(said);
  await expect(overview.locator('[data-overview-section="operator"]')).toContainText("area under the ROC curve");
  // The project's own operators come first, the built-in ones are counted.
  await expect(overview.locator('[data-overview-section="operator"]')).toContainText("built-in");
  await expect(overview.locator("[data-overview-person]")).toHaveCount(0);

  // A model's page says what it is, from its README.
  const onset = ((await alice("GET", `/models?project=${project.rid}&limit=50`)) as { items: { metadata: { name: string; rid: string } }[] }).items.find(m => m.metadata.name === "Diabetes onset risk")?.metadata.rid as string;
  await page.goto(`/models/${onset}`);
  await expect(page.locator("[data-model-card]")).toContainText("Estimates who is likely");
  await expect(page.locator("[data-model-contract]")).toContainText("Glucose");
  await shot(page, "2-the-model");
  // The operators page: the project's own first, the built-in ones behind a click.
  await page.goto("/operators");
  const rows = page.locator('[data-library="operator"] [data-resource-row="operator"]');
  await expect(rows).toHaveCount(4);
  await page.locator("[data-built-in-operators]").click();
  await expect.poll(() => rows.count()).toBeGreaterThan(50);
  await shot(page, "3-operators");

  // Part 2: a file brought to the chat stays the chat's, and the agent reads it.
  await page.goto("/");
  await page.locator("[data-attach-input]").setInputFiles(FILE);
  await ask(page, CHECK);
  const chat = conversationOf(page);
  // Until the chat starts work it is the page: the project is not under it.
  await expect(page.locator("[data-project-overview]")).toHaveCount(0);
  await turnEnds(page);
  let said = await messagesOf(alice, chat);
  expect(toolsOf(said)).toContain("read_dataset_file");
  expect(toolsOf(said)).not.toContain("create_dataset");
  // It recommends the team's onset-risk model: in words, or by its link, which the chat shows as the model's card.
  expect(answerOf(said)).toMatch(new RegExp(`onset.?risk|texera://models/${onset}`, "i"));
  const listed = async () => ((await alice("GET", `/datasets?project=${project.rid}&limit=20`)) as { items: { metadata: { name: string } }[] }).items.map(d => d.metadata.name);
  expect(await listed()).not.toContain("screening_cohort.csv");

  // It says where it would run: she picks, it builds the pipeline, and the graph shows beside the chat.
  const card = page.locator('[data-part="ask"]').last();
  if ((await card.count()) === 0) {
    // A model is free to stop at its recommendation: the README says what to say then.
    await say(page, "Go ahead and apply it to this file.");
    await turnEnds(page);
  }
  await expect(card).toBeVisible();
  await shot(page, "4-which-model");
  // Someone coming back to answer: the chat opens at its end, and goes on to follow the answer.
  await page.reload();
  await expect(card).toBeInViewport({ timeout: 30_000 });
  await card.locator("[data-ask-option]").filter({ hasText: "Public unit" }).first().click();
  await turnEnds(page);
  await expect(page.locator("[data-message-seq]").last()).toBeInViewport({ timeout: 15_000 });
  const graph = page.locator("[data-resource-graph]");
  await expect(graph).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-chat-window]")).not.toHaveAttribute("data-chat-maximized", "true");
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "screening_cohort" }).first()).toBeVisible();
  const run = graph.locator('[data-graph-role="run"]');
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-graph-state", "completed");
  await expect(graph.locator('[data-graph-role="model"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-edge="uses"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-role="unit"]').filter({ hasText: "Public unit" })).toHaveCount(1);
  await graph.locator("[data-graph-fit]").click();
  await page.waitForTimeout(800);
  await shot(page, "5-the-graph");

  // The model ran on the 154 women it never saw; which figures it reports of them is the agent's
  // choice, and an AUC, when it measures one, is the one the data gives.
  const workflows = (await alice("GET", `/workflows?project=${project.rid}&limit=10`)) as { items: { metadata: { rid: string; name: string } }[] };
  const workflow = workflows.items.find(w => w.metadata.name !== "CGM metrics per adolescent") as { metadata: { rid: string; name: string } };
  type Execution = { metadata: { rid: string }; status: { phase: string; ports: { operatorID: string; portID: string; rows: number }[] } };
  const runs = ((await alice("GET", `/workflows/${workflow.metadata.rid}/executions?limit=10`)) as { items: Execution[] }).items;
  const done = runs.find(e => e.status.phase === "completed") as Execution;
  let auc: number[] | undefined;
  for (const port of done.status.ports.filter(p => p.rows === 1)) {
    const page1 = (await alice("GET", `/workflows/${workflow.metadata.rid}/executions/${done.metadata.rid}/operators/${port.operatorID}/ports/${port.portID}/rows?limit=1`)) as { schema: { attributeName: string }[]; rows: unknown[][] };
    const at = page1.schema.findIndex(c => c.attributeName === "auc");
    if (at >= 0) auc = [page1.rows[0]?.[0] as number, page1.rows[0]?.[at] as number];
  }
  expect(done.status.ports.some(p => p.rows === 154), "the women it never saw").toBe(true);
  if (auc) {
    expect(auc[0]).toBe(154);
    expect(auc[1]).toBeCloseTo(0.8467, 3);
  }

  // What is published, and the file kept.
  await say(page, LITERATURE);
  await turnEnds(page);
  said = await messagesOf(alice, chat);
  expect(toolsOf(said)).toContain("search_pubmed");
  await expect(page.locator("[data-graph-sources]")).toContainText("biomcp");
  await shot(page, "6-the-literature");
  await say(page, KEEP);
  await turnEnds(page);
  said = await messagesOf(alice, chat);
  expect(toolsOf(said)).toContain("keep_attachment");
  expect(await listed()).toContain("Screening cohort");

  // Part 3: Bob finds what was built, and they work on it together.
  const bobs = await browserOf(browser, "bob");
  await bobs.goto(`/projects/${project.rid}`);
  await expect(bobs.getByText(workflow.metadata.name, { exact: true }).first()).toBeVisible();
  await expect(bobs.getByText("Screening cohort", { exact: true }).first()).toBeVisible();
  await shot(bobs, "7-bob-finds-the-workflow");

  await together(page, bobs, alice, workflow.metadata.rid, "8");
});

test("the story: what models and data there are, an inference on the ones picked from their cards, on a unit she makes, and the chat shared with a teammate who takes part", async ({ page, browser, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.skip(!existsSync(FILE), `run prepare.py first: no ${FILE}`);
  test.setTimeout(2_400_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const alice = await api(request);
  const bob = await api(request, "bob");
  const project = teamProject();
  cleanups.push(() => emptied(alice, project.rid));
  await signIn(page);
  await workHere(page, alice, project.rid);
  await page.goto("/");

  // She asks what models there are: each comes back as a card, and the chat names itself.
  await ask(page, MODELS);
  const chat = conversationOf(page);
  await turnEnds(page);
  const header = page.locator("[data-chat-header]");
  await expect(header).not.toContainText("New chat", { timeout: 30_000 });
  const chatName = ((await alice("GET", `/resources/${chat}`)) as { metadata: { name: string } }).metadata.name;
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(chatName, { timeout: 20_000 });
  const cardsOf = (kind: string) => page.locator(`[data-part="resources"] [data-resource-card="${kind}"]`);
  await expect.poll(() => cardsOf("model").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const theModel = cardsOf("model").filter({ hasText: "Undiagnosed diabetes risk" }).last();
  await expect(theModel).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"]').last()).not.toContainText("texera://");
  await shot(page, "s1-model-cards");

  // Then the data: cards again.
  await say(page, WHICH_DATA);
  await turnEnds(page);
  const theData = cardsOf("dataset").filter({ hasText: "NHANES" }).last();
  await expect(theData).toBeVisible();
  await shot(page, "s2-data-cards");

  // One of each goes with the next message, marked on the card and in the box.
  await theModel.locator("[data-card-pick]").click();
  await theData.locator("[data-card-pick]").click();
  await expect(theModel).toHaveAttribute("data-card-picked", "true");
  await expect(theData).toHaveAttribute("data-card-picked", "true");
  const picks = page.locator("[data-composer-pick]");
  await expect(picks).toHaveCount(2);
  await shot(page, "s3-picked");
  await say(page, BUILD);
  await expect(picks).toHaveCount(0);
  await expect(page.locator('[data-message-role="user"]').last().locator("[data-resource-card]")).toHaveCount(2);
  await turnEnds(page);

  // Where it runs is hers to say, in sizes, and she makes a unit of her own.
  const where = page.locator('[data-part="ask"]').last();
  await expect(where).toBeVisible();
  const options = (await where.locator("[data-ask-option]").allInnerTexts()).join(" | ");
  expect(options).toMatch(/Public unit/);
  expect(options).toMatch(/Small/);
  expect(options).not.toMatch(/team unit|deployment|cluster unit/i);
  await shot(page, "s4-where-it-runs");
  await where.locator("[data-ask-option]").filter({ hasText: "Small" }).first().click();
  await turnEnds(page);

  // It ran: on the unit she made, with the model she picked, over the data she picked.
  const graph = page.locator("[data-resource-graph]");
  await expect(graph).toBeVisible({ timeout: 60_000 });
  await expect(graph.locator('[data-graph-role="run"][data-graph-state="completed"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(graph.locator('[data-graph-role="model"]').filter({ hasText: "Undiagnosed" })).toHaveCount(1);
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "NHANES" }).first()).toBeVisible();
  await expect(graph.locator('[data-graph-role="unit"]').filter({ hasText: "Small" })).toHaveCount(1);
  await graph.locator("[data-graph-fit]").click();
  await page.waitForTimeout(800);
  await shot(page, "s5-it-ran");
  type Made = { resource: { kind: string; metadata: { rid: string; name: string } }; made: boolean };
  const made = (await alice("GET", `/conversations/${chat}/resources`)) as Made[];
  const workflow = made.find(m => m.made && m.resource.kind === "workflow")?.resource as Made["resource"];
  expect(workflow).toBeDefined();
  const spec = ((await alice("GET", `/workflows/${workflow.metadata.rid}`)) as { spec: { operators: { operatorID: string; operatorType: string; operatorProperties: { model?: string } }[] } }).spec;
  const predict = spec.operators.find(o => o.operatorType === "predict");
  expect(predict?.operatorProperties.model).toBeDefined();
  type Run = { status: { phase: string; operators: Record<string, { rowsOut?: number }> } };
  const runs = ((await alice("GET", `/workflows/${workflow.metadata.rid}/executions?limit=10`)) as { items: Run[] }).items;
  const done = runs.find(e => e.status.phase === "completed") as Run;
  expect(done.status.operators[predict?.operatorID as string]?.rowsOut, "the people it scored").toBeGreaterThan(1000);

  // She shares the chat. Bob finds it, and sees all she sees, the results too.
  await header.locator("[data-share]").click();
  const dialog = page.locator("[data-share-dialog]");
  await dialog.getByLabel("Principal").fill("bob");
  await dialog.locator('[data-principal="Bob Builder"]').click();
  await dialog.getByLabel("Relation").selectOption("editor");
  await dialog.locator("[data-grant-button]").click();
  await expect(dialog.locator("[data-grants] [data-grant]").filter({ hasText: "Bob Builder" })).toHaveAttribute("data-grant", "editor");
  await shot(page, "s6-shared");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const bobs = await browserOf(browser, "bob");
  await bobs.goto("/shared");
  await bobs.locator("[data-shared-with-me] [data-resource-row]").filter({ hasText: chatName }).getByRole("button", { name: chatName }).click();
  await expect(bobs).toHaveURL(new RegExp(chat));
  await expect(bobs.locator('[data-message-role="user"]')).toHaveCount(await page.locator('[data-message-role="user"]').count(), { timeout: 30_000 });
  await expect(bobs.locator('[data-part="resources"] [data-resource-card="model"]').filter({ hasText: "Undiagnosed diabetes risk" }).first()).toBeVisible();
  const bobsGraph = bobs.locator("[data-resource-graph]");
  await expect(bobsGraph.locator('[data-graph-role="run"][data-graph-state="completed"]').first()).toBeVisible({ timeout: 30_000 });
  const present = (on: Page) => on.locator("[data-presence] [data-present]");
  await expect(present(page)).toHaveCount(2, { timeout: 15_000 });
  await expect(present(bobs)).toHaveCount(2, { timeout: 15_000 });
  await shot(bobs, "s7-bob-sees-it-all");

  // He asks the agent. She sees his words and that it is his turn; the answer reaches them both.
  const bobPid = ((await bob("GET", "/me")) as { principal: { pid: string } }).principal.pid;
  const said = (on: Page, text: string) => on.locator('[data-message-role="user"]').filter({ hasText: text });
  await say(bobs, BOB_ASKS);
  await expect(said(page, BOB_ASKS)).toBeVisible({ timeout: 20_000 });
  await expect(said(page, BOB_ASKS).locator(`[data-message-author="${bobPid}"]`)).toBeVisible();
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toBeVisible({ timeout: 20_000 });
  await turnEnds(bobs);
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toHaveCount(0, { timeout: 30_000 });
  const lastAnswer = (on: Page) => on.locator('[data-message-role="assistant"]').last();
  const answered = ((await lastAnswer(bobs).textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(answered.length).toBeGreaterThan(20);
  await expect(lastAnswer(page)).toContainText(answered.slice(-60), { timeout: 30_000 });
  await shot(page, "s8-both-see-the-answer");

  // A note from her reaches him, marked as a note, and nothing asks the agent.
  const answers = await page.locator('[data-message-role="assistant"]').count();
  await page.getByLabel("Message", { exact: true }).fill(ALICE_NOTES);
  await page.locator("[data-send-note]").click();
  await expect(said(bobs, ALICE_NOTES)).toBeVisible({ timeout: 15_000 });
  await expect(said(bobs, ALICE_NOTES).locator("[data-message-note]")).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(answers);

  // All of it is still there after a reload, for each.
  for (const on of [page, bobs]) {
    await on.reload();
    await expect(said(on, BOB_ASKS)).toBeVisible({ timeout: 30_000 });
    await expect(said(on, ALICE_NOTES)).toBeVisible();
    await expect(on.locator("[data-chat-header]")).toContainText(chatName);
  }

  // They open the workflow it built together.
  await together(page, bobs, alice, workflow.metadata.rid, "s9");
});
