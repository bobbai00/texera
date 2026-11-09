import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, ask, type Caller, cleanups, conversationOf, operatorList, say, signIn, tidyUp } from "./support";

// The demo in the README of bin/texera-2-0/examples/diabetes, whole, through the real model and in
// two browsers. Alice lands on her project: what it holds and who is in it, with the chat over it.
// She attaches a file, which stays the chat's; asks what it is and which of the team's models fits;
// the agent builds the pipeline on the unit she picks, and the graph takes the place of the
// overview. She asks what is published, and keeps the file. Bob, in his own browser, finds the
// workflow; they open it together, see each other's pointers, and what he adds appears on her canvas.

test.afterEach(tidyUp);

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = `${REPO}bin/texera-2-0/examples/diabetes`;
const DATA = process.env.TEXERA_DIABETES_DATA ?? join(homedir(), "texera-diabetes");
const FILE = join(DATA, "uploads", "screening_cohort.csv");

const CHECK = "Can you check what's in this data? I want to analyze it using the models in our project. Which model do you think works best? Please go ahead and run it.";
const LITERATURE = "How does that compare with what has been published on models like this? Cite what you find.";
const KEEP = "Please keep this file as a dataset called Screening cohort.";

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
  await signIn(page, user, user);
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

type Message = { role: string; parts: { type: string; toolName?: string; text?: string }[] };
const messagesOf = async (as: Caller, chat: string) => ((await as("GET", `/conversations/${chat}/messages?limit=200`)) as { items: Message[] }).items;
const toolsOf = (messages: Message[]) => messages.flatMap(m => m.parts.filter(p => p.type === "tool_call").map(p => p.toolName));
const answerOf = (messages: Message[]) => (messages.at(-1) as Message).parts.filter(p => p.type === "text").map(p => p.text).join("");

test("the demo: a project at a glance, a file brought to the chat and analyzed with the team's model, and two people on the workflow it made", async ({ page, browser, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.skip(!existsSync(FILE), `run prepare.py first: no ${FILE}`);
  test.setTimeout(2_400_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const alice = await api(request);
  const project = teamProject();
  cleanups.push(() => emptied(alice, project.rid));
  await signIn(page);
  await page.goto(`/projects/${project.rid}`);
  await page.locator("[data-work-here]").click();
  await expect(page.locator("[data-working-here]")).toBeVisible();
  // The badge is the app following at once; the catalog keeps the pick a moment later.
  await expect.poll(async () => ((await alice("GET", "/me")) as { preferences: { project?: string } }).preferences.project).toBe(project.rid);

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
    ["dataset", "View all 7"],
    ["model", "View all 6"],
    ["workflow", "View all 6"],
    ["operator", "ROC AUC"],
    ["computing-unit", "Team unit"],
  ] as const)
    await expect(overview.locator(`[data-overview-section="${kind}"]`)).toContainText(said);
  await expect(overview.locator('[data-overview-section="operator"]')).toContainText("area under the ROC curve");
  // The project's own operators come first, the built-in ones are counted.
  await expect(overview.locator('[data-overview-section="operator"]')).toContainText("built-in");
  await expect(overview.locator("[data-overview-person]")).toHaveCount(0);

  // A model's page says what it is, from its README.
  await page.goto(`/models/${(await alice("GET", `/models?project=${project.rid}&limit=50`)).items.find((m: { metadata: { name: string } }) => m.metadata.name === "Diabetes onset risk").metadata.rid}`);
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
  await expect(page.locator(`[data-chat-behind] [data-project-overview="${project.rid}"]`)).toBeVisible();
  await turnEnds(page);
  let said = await messagesOf(alice, chat);
  expect(toolsOf(said)).toContain("read_dataset_file");
  expect(toolsOf(said)).not.toContain("create_dataset");
  expect(answerOf(said)).toMatch(/onset.?risk/i);
  const listed = async () => ((await alice("GET", `/datasets?project=${project.rid}&limit=20`)) as { items: { metadata: { name: string } }[] }).items.map(d => d.metadata.name);
  expect(await listed()).not.toContain("screening_cohort.csv");

  // It says where it would run: she picks, it builds the pipeline, and the graph takes the overview's place.
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
  await card.locator("[data-ask-option]").filter({ hasText: "Team unit" }).first().click();
  await turnEnds(page);
  await expect(page.locator("[data-message-seq]").last()).toBeInViewport({ timeout: 15_000 });
  const graph = page.locator("[data-resource-graph]");
  await expect(graph).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-chat-behind]")).toHaveCount(0);
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "screening_cohort" }).first()).toBeVisible();
  const run = graph.locator('[data-graph-role="run"]');
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-graph-state", "completed");
  await expect(graph.locator('[data-graph-role="model"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-edge="uses"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-role="unit"]').filter({ hasText: "Team unit" })).toHaveCount(1);
  await graph.locator("[data-graph-fit]").click();
  await page.waitForTimeout(800);
  await shot(page, "5-the-graph");

  // The numbers are the ones the data gives: the AUC of the model on the women it never saw.
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
  expect(auc?.[0], "the women it never saw").toBe(154);
  expect(auc?.[1]).toBeCloseTo(0.8467, 3);

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

  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await bobs.goto(`/workflows/${workflow.metadata.rid}`);
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
  await shot(page, "8-each-others-pointers");

  // What he adds appears on her canvas, with no reload, and goes into the next version.
  const before = await page.locator(".react-flow__node-operator").count();
  const palette = await operatorList(bobs);
  await palette.getByPlaceholder("Search operators").fill("Limit");
  await palette.locator('[data-palette-operator="Limit"]').click();
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(page.locator('.react-flow__node [data-operator-type="Limit"]')).toHaveCount(1);
  await bobs.locator("[data-operator-done]").click();
  await expect
    .poll(async () => ((await alice("GET", `/workflows/${workflow.metadata.rid}`)) as { spec: { operators: { operatorType: string }[] } }).spec.operators.some(o => o.operatorType === "Limit"), { timeout: 30_000 })
    .toBe(true);
  await shot(page, "9-edited-together");
});
