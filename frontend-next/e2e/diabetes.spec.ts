import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { api, ask, cleanups, conversationOf, createdIn, say, signIn, tidyUp, workAtHome, workIn } from "./support";

// The diabetes use case in the app, through the real model: a researcher in the team's project
// asks what the platform gives her, has the agent bring the public Pima cohort into a dataset,
// and asks to screen it with the team's onset-risk model. The agent asks where to run it, she
// picks Small on the card, and the chat's graph shows the cohort and the model going into the
// workflow, with the team's operators, and the workflow running on her unit. The team's project
// is made by the scenarios' own Python (texera_e2e.diabetes), which fits the model.

test.afterEach(tidyUp);

const PIMA_URL = "https://raw.githubusercontent.com/plotly/datasets/master/diabetes.csv";
const REPO = fileURLToPath(new URL("../../", import.meta.url));

type Team = { project: string; name: string; model: string; roc_auc: string; calibration: string };

function teamProject(name: string): Team {
  const gw = process.env.TEXERA_BASE_URL ?? "http://localhost:8088";
  const out = execFileSync(`${REPO}.venv/bin/python`, ["-m", "texera_e2e.diabetes", "--gw", gw, "--name", name], {
    cwd: `${REPO}tests/e2e`,
    encoding: "utf8",
    timeout: 180_000,
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as Team;
}

/** Waits for a turn that has started to end: the composer offers to stop it, then to send again. */
async function turnEnds(page: Page) {
  await expect(page.getByLabel("Stop generating")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Stop generating")).toBeHidden({ timeout: 900_000 });
}

/** Says something in the chat and waits for the agent's turn to end. */
async function sayAndWait(page: Page, text: string) {
  await say(page, text);
  await turnEnds(page);
}

test("a diabetes researcher brings in a public cohort, screens it with the team's model on a unit she picks, and sees it all on the graph", async ({
  page,
  request,
}) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(2_400_000);
  const alice = await api(request);
  const team = teamProject(`Diabetes research ${Date.now()}`);
  let conversation: string | undefined;
  cleanups.push(async () => {
    const made = conversation ? await createdIn(alice, conversation) : [];
    for (const r of made)
      if (r.kind === "computing-unit") await alice.attempt("POST", `/computing-units/${r.metadata.rid}/terminate`, {});
    for (const r of made)
      if (r.kind === "execution" && r.metadata.parent)
        await alice.attempt("DELETE", `/workflows/${r.metadata.parent}/executions/${r.metadata.rid}`);
    for (const kind of ["workflow", "dataset", "computing-unit"])
      for (const r of made) if (r.kind === kind) await alice.attempt("DELETE", `/resources/${r.metadata.rid}`);
    if (conversation) await alice.attempt("DELETE", `/resources/${conversation}`);
    for (const uri of [team.model, team.roc_auc, team.calibration])
      await alice.attempt("DELETE", `/resources/${uri.split("/").at(-1)}`);
    await alice.attempt("DELETE", `/projects/${team.project}`);
    await workAtHome(alice);
  });

  await signIn(page);
  await workIn(page, team.name);
  // What there is.
  await ask(
    page,
    "I study type 2 diabetes and I'm new to this team. What tools does this platform give me: data, models, operators, and where my work can run?"
  );
  conversation = conversationOf(page);
  await turnEnds(page);
  expect(await createdIn(alice, conversation)).toEqual([]);

  // The cohort comes in.
  await sayAndWait(
    page,
    `Please get the Pima Indians diabetes data from ${PIMA_URL} and put it into a new dataset called 'Pima cohort'.`
  );
  const datasets = (await createdIn(alice, conversation)).filter(r => r.kind === "dataset");
  expect(datasets).toHaveLength(1);

  // The screening: the agent asks where it runs, and she picks Small on the card.
  await sayAndWait(
    page,
    "Now screen every woman in the Pima cohort with our diabetes onset-risk model: how well does its risk separate the women who developed diabetes from those who did not, and is it calibrated? Use the team's ROC AUC and Risk calibration operators."
  );
  const card = page.locator('[data-part="ask"]').last();
  await expect(card).toBeVisible();
  // Sizes to choose from: Small if it is offered, else the smallest there is.
  const sizes = card.locator("[data-ask-option]").filter({ hasText: /Small|Medium|Large/ });
  await expect(sizes.nth(1)).toBeVisible();
  const small = card.locator("[data-ask-option]").filter({ hasText: "Small" });
  const choice = (await small.count()) > 0 ? small.first() : sizes.first();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/diabetes-ask.png" });
  await choice.click();
  await turnEnds(page);

  // The graph: the cohort goes into the workflow, the model and the team's operators ride on
  // its card, and the workflow stands in the frame of her unit.
  const graph = page.locator("[data-resource-graph]");
  await expect(graph).toBeVisible({ timeout: 60_000 });
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "Pima cohort" }).first()).toBeVisible();
  const units = (await createdIn(alice, conversation)).filter(r => r.kind === "computing-unit");
  expect(units).toHaveLength(1);
  const unitUri = `texera://computing-units/${units[0]?.metadata.rid}`;
  const screen = graph.locator(`[data-graph-role="workflow"][data-graph-runs-on="${unitUri}"]`);
  await expect(screen).toHaveCount(1);
  await expect(graph.locator(`[data-graph-role="unit"][data-graph-node="${unitUri}"]`)).toHaveCount(1);
  await expect(screen.locator('[data-graph-role="model"]').filter({ hasText: "Diabetes onset risk" })).toHaveCount(1);
  await expect(screen.locator('[data-graph-role="function"]')).not.toHaveCount(0);
  await expect(graph.locator('[data-graph-edge="reads"]')).not.toHaveCount(0);
  await expect(graph.locator('[data-graph-edge="makes"]')).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/diabetes-graph.png", fullPage: true });
  // Closer, the workflow's steps: the cohort scanned, the model's predict, the team's operators.
  await screen.dblclick();
  await expect(screen.locator("[data-graph-step]").filter({ hasText: "predict" })).toHaveCount(1);
  await expect(screen.locator('[data-graph-step] [data-graph-role="model"]')).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/diabetes-graph-steps.png", fullPage: true });
});
