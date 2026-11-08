import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, cleanups, inTurn, signIn, tidyUp, withIris } from "./support";

// Once a chat starts work, what it reads, makes and runs takes the left of the chat page as a
// graph: Data, Computation and Results. In the computation each workflow's card stands beside
// its runs, each run a box in the lane of the unit it ran on, the unit at the lane's foot, dotted
// ties joining a run to both; arrows are only for data; what the plan has not made yet is dashed.
// Nothing moves when more arrives (only a unit, which stays at its lane's foot); it zooms from the
// whole graph to each workflow's steps. A click on any box goes into it: its own view over the
// graph, with the trail back; what that view links to opens there too, and the chat beside it
// never changes. The agent's calls are made here as the runtime makes them, in a turn of the chat,
// so no model is needed.

test.afterEach(tidyUp);

/** Where each box of the graph is on screen, by what it stands for; units at the lanes' feet go down as rows come. */
async function positions(graph: Locator) {
  const out = new Map<string, { x: number; y: number }>();
  for (const node of await graph.locator("[data-graph-node]:not([data-graph-foot])").all()) {
    const box = await node.boundingBox();
    if (box)
      out.set((await node.getAttribute("data-graph-node")) as string, { x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

/** The view over the graph after going into a box: what kind it is, and the trail's last step. */
async function wentInto(page: Page, kind: string, last: string | RegExp) {
  const focus = page.locator("[data-graph-focus]");
  await expect(focus).toHaveAttribute("data-graph-focus-kind", kind);
  await expect(focus.locator("[data-graph-crumbs] [aria-current=page]")).toContainText(last);
  return focus;
}

/** All the way back: the view gives way and the graph is there. */
async function backToGraph(page: Page) {
  await page.locator('[data-graph-crumb="root"]').click();
  await expect(page.locator("[data-graph-focus]")).toHaveCount(0);
  await expect(page.locator("[data-resource-graph]")).toBeVisible();
}

test("a chat's graph stands each run where its workflow meets its unit, and goes into any box and back with the chat untouched", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const iris = await withIris(alice, "a chat's graph");
  const conversation = (
    await alice("POST", "/conversations", { name: `the graph ${Date.now()}`, parent: iris.project, spec: {} })
  ).metadata.rid as string;
  const others: string[] = [];
  cleanups.push(() => iris.clear(conversation, others));
  const file = `texera://datasets/${iris.dataset}@1/files/iris.csv`;
  const link = (from: string, to: string) => ({
    linkID: `${from}-${to}`,
    source: { operatorID: from, portID: "output-0" },
    target: { operatorID: to, portID: "input-0" },
  });
  const means = (where: string) => ({
    operators: [
      { operatorID: "readings", operatorType: "scan", operatorProperties: { file } },
      {
        operatorID: "means",
        operatorType: "aggregate",
        operatorProperties: { by: ["Species"], outputs: ["mean = avg(PetalLengthCm)"] },
      },
      { operatorID: "long", operatorType: "filter", operatorProperties: { where } },
    ],
    links: [link("readings", "means"), link("means", "long")],
  });

  // The agent reads up in an outside source, says its plan, makes a workflow over the person's
  // iris and runs it.
  const servers = (await alice("GET", "/mcp-servers?limit=200")).items as { metadata: { name: string; uri: string } }[];
  const biomcp = servers.find(s => s.metadata.name === "biomcp")?.metadata.uri;
  expect(biomcp).toBeDefined();
  let agent = await inTurn(request, alice, conversation);
  await agent("POST", `/conversations/${conversation}/messages`, {
    turn: agent.turn,
    role: "assistant",
    parts: [
      {
        type: "tool_call",
        toolName: "search_pubmed",
        toolCallId: "c0",
        server: biomcp,
        args: { query: "iris petal length" },
      },
      {
        type: "tool_call",
        toolName: "start_work",
        toolCallId: "c1",
        args: {
          goal: "Petal means",
          makes: [
            { kind: "workflow", name: "petal means" },
            { kind: "dataset", name: "Long petals" },
          ],
        },
      },
    ],
  });
  const first = await agent("POST", "/workflows", { name: "petal means", spec: means("mean > 2") });
  const ran = await agent("POST", `/workflows/${first.metadata.rid}/run`, { waitSeconds: 120 });
  await agent.end();
  const unit = ran.spec.computingUnit as string;
  const workflow = first.metadata.uri as string;

  await signIn(page);
  await page.goto(`/conversations/${conversation}`);
  const graph = page.locator("[data-resource-graph]");
  const workflows = graph.locator('[data-graph-role="workflow"]');
  await expect(workflows).toHaveCount(1);
  await expect(workflows.first()).toContainText("petal means");
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "iris" })).toHaveCount(1);
  // Its run is a box of its own in the lane of the unit it ran on, the unit at the lane's foot,
  // dotted ties to both; the plan's dataset, not made yet, beside it.
  const run = graph.locator(`[data-graph-role="run"][data-graph-of="${workflow}"]`);
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-graph-unit", unit);
  await expect(run).toHaveAttribute("data-graph-state", "completed");
  const foot = graph.locator(`[data-graph-foot="${unit}"]`);
  await expect(foot).toHaveCount(1);
  const [box, base, card] = [await run.boundingBox(), await foot.boundingBox(), await workflows.first().boundingBox()];
  expect(box && base && card).toBeTruthy();
  if (box && base && card) {
    expect(base.y).toBeGreaterThan(box.y + box.height);
    expect(Math.abs(base.x + base.width / 2 - (box.x + box.width / 2))).toBeLessThan(2);
    expect(box.x).toBeGreaterThan(card.x + card.width);
    expect(Math.abs(box.y + box.height / 2 - (card.y + 0.2 * card.height))).toBeLessThan(card.height * 0.25);
  }
  await expect(graph.locator('[data-graph-tie="tether"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-tie="rail"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-planned="true"]')).toContainText("Long petals");
  // Arrows are data only: the iris file read, the tables the run made.
  await expect(graph.locator('[data-graph-edge="reads"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-edge="makes"]')).not.toHaveCount(0);
  await expect(graph.locator('[data-graph-edge="runsOn"], [data-graph-edge="uses"]')).toHaveCount(0);
  await expect(graph.locator('[data-graph-column="data"]')).toContainText("Data");
  await expect(graph.locator('[data-graph-column="computation"]')).toContainText("Computation");
  await expect(graph.locator('[data-graph-column="results"]')).toContainText("Results");
  // Above it, the outside source the agent consulted; a click lists what it asked.
  const source = graph.locator('[data-graph-sources] [data-graph-source="biomcp"]');
  await expect(source).toContainText("1 call");
  await source.click();
  await expect(graph.locator("[data-graph-calls] li")).toHaveCount(1);
  await expect(graph.locator("[data-graph-calls] li")).toContainText("iris petal length");
  await page.screenshot({ path: "test-results/resource-graph.png" });
  const before = await positions(graph);

  // A second workflow arrives, with a function the agent makes, not run yet: its run waits on
  // its default unit, in the same lane. Nothing already there moves.
  agent = await inTurn(request, alice, conversation);
  const code =
    'import pandas as pd\n\n\n@returns(Species=str, n=int)\ndef count_species(rows: pd.DataFrame):\n    return rows.groupby("Species").size().reset_index(name="n")\n';
  const fn = await agent("POST", "/operators", {
    name: "count species",
    spec: { implementation: { python: { code } } },
  });
  others.push(fn.metadata.rid as string);
  await agent("POST", "/workflows", {
    name: "species counts",
    spec: {
      defaultComputingUnit: unit,
      operators: [
        { operatorID: "readings", operatorType: "scan", operatorProperties: { file } },
        { operatorID: "count", operatorType: `${fn.metadata.uri}@1`, operatorProperties: {} },
      ],
      links: [link("readings", "count")],
    },
  });
  await agent.end();
  await expect(workflows).toHaveCount(2, { timeout: 30_000 });
  const waiting = graph.locator('[data-graph-role="run"][data-graph-state="idle"]');
  await expect(waiting).toHaveAttribute("data-graph-unit", unit);
  const [one, two] = [await run.boundingBox(), await waiting.boundingBox()];
  expect(one && two && Math.abs(one.x - two.x)).toBeLessThan(2);
  const after = await positions(graph);
  for (const [id, place] of before) expect(after.get(id), id).toEqual(place);
  await expect(graph.locator(`[data-graph-uses="${fn.metadata.uri}"]`)).toHaveCount(1);

  // Closer, a workflow shows its steps, each table level with the step that made it, and its
  // run runs the height of the steps; further, only names.
  await graph.locator('[data-graph-level="detail"]').click();
  await expect(graph.locator("[data-graph-zoom]")).toHaveAttribute("data-graph-zoom", "detail");
  const petals = workflows.filter({ hasText: "petal means" });
  await expect(petals.locator("[data-graph-step]")).toHaveText([
    /readings\s*scan\s*iris\.csv/,
    /means\s*aggregate/,
    /long\s*filter\s*where mean > 2/,
  ]);
  await expect(graph.locator("[data-graph-file]").first()).toHaveText("iris.csv");
  const step = await petals.locator('[data-graph-step="long"]').boundingBox();
  const table = await graph.locator(`[data-graph-of="${workflow}"]`).filter({ hasText: "long" }).boundingBox();
  expect(step && table && Math.abs(step.y + step.height / 2 - (table.y + table.height / 2))).toBeLessThan(3);
  const [bar, tall] = [await run.boundingBox(), await petals.boundingBox()];
  expect(bar && tall && bar.height).toBeGreaterThan((tall?.height ?? 0) * 0.7);
  await page.screenshot({ path: "test-results/resource-graph-detail.png" });
  await graph.locator('[data-graph-level="overview"]').click();
  await expect(graph.locator("[data-graph-zoom]")).toHaveAttribute("data-graph-zoom", "overview");
  await expect(graph.locator("[data-graph-step]")).toHaveCount(0);
  await graph.locator("[data-graph-fit]").click();

  // Going into boxes: the chat beside it never changes, and nothing opens beside the page.
  const said = await page.locator("[data-message-seq]").count();
  const address = new URL(page.url()).pathname;

  // A workflow: its own view, with what it is to the rest of the graph above it.
  await petals.click({ position: { x: 14, y: 12 } });
  let focus = await wentInto(page, "resource", "petal means");
  await expect(
    focus.locator(`[data-graph-view="workflow"] [data-workflow-view="${first.metadata.rid}"]`)
  ).toBeVisible();
  await expect(focus.locator("[data-graph-related]")).toContainText("Reads");
  await expect(focus.locator("[data-graph-related]")).toContainText("iris");
  await page.screenshot({ path: "test-results/resource-graph-workflow.png" });
  await focus.locator("[data-graph-back]").click();
  await expect(page.locator("[data-graph-focus]")).toHaveCount(0);

  // A run: the execution, completed. From it, a table it made; the trail grows, and goes back.
  await run.click();
  focus = await wentInto(page, "run", "petal means");
  await expect(focus.locator("[data-execution-view] [data-phase]")).toHaveText("completed");
  await expect(focus.locator("[data-graph-related]")).toContainText("On");
  await page.screenshot({ path: "test-results/resource-graph-run.png" });
  await focus.locator('[data-graph-related] [data-graph-go$="/operators/long/ports/output-0"]').click();
  focus = await wentInto(page, "table", "long");
  await expect(focus.locator("[data-graph-crumbs] [data-graph-crumb]")).toHaveCount(3);
  await expect(focus.locator("[data-port-rows]")).toBeVisible();
  await focus.locator('[data-graph-crumb="0"]').click();
  focus = await wentInto(page, "run", "petal means");
  // What the run's view links to opens here too: its workflow, after it on the trail.
  await focus.locator('[data-execution-view] [data-uri-chip="workflow"]').first().click();
  focus = await wentInto(page, "resource", "petal means");
  await expect(focus.locator("[data-graph-crumbs] [data-graph-crumb]")).toHaveCount(3);
  await expect(page.locator("[data-side-panel]")).toHaveCount(0);
  // Alt+Left goes back a step, Escape from the trail all the way.
  await page.keyboard.press("Alt+ArrowLeft");
  focus = await wentInto(page, "run", "petal means");
  await focus.locator("[data-graph-back]").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-graph-focus]")).toHaveCount(0);

  // A table: the rows its run kept; from there, the run that made them.
  await graph.locator(`[data-graph-of="${workflow}"]`).filter({ hasText: "long" }).click();
  focus = await wentInto(page, "table", "long");
  await expect(focus.locator("[data-port-rows]")).toBeVisible();
  await expect(focus.locator("[data-graph-related]")).toContainText("Made by");
  await focus.locator("[data-open-execution]").click();
  await wentInto(page, "run", "petal means");
  await backToGraph(page);

  // The dataset, the unit, the function on the second workflow, its run that has not happened,
  // and the plan's dataset.
  await graph.locator('[data-graph-role="data"]').filter({ hasText: "iris" }).click();
  focus = await wentInto(page, "resource", "iris");
  await expect(focus.locator('[data-graph-view="dataset"]')).toContainText("iris.csv");
  await expect(focus.locator("[data-graph-related]")).toContainText("Read by");
  await backToGraph(page);
  await foot.click();
  focus = await wentInto(page, "resource", /.+/);
  await expect(focus.locator('[data-graph-view="computing-unit"]')).toBeVisible();
  await expect(focus.locator("[data-graph-related] [data-graph-go]")).toHaveCount(2);
  await backToGraph(page);
  await graph.locator(`[data-graph-uses="${fn.metadata.uri}"]`).click();
  focus = await wentInto(page, "resource", "count species");
  await expect(focus.locator('[data-graph-view="operator"]')).toContainText("def count_species");
  await expect(focus.locator("[data-graph-related]")).toContainText("Used by");
  // It was made in this chat: going to that chat from it is going back to the graph beside it.
  await focus.locator(`[data-made-in="${conversation}"], [data-origin]`).first().click();
  await expect(page.locator("[data-graph-focus]")).toHaveCount(0);
  await expect(page.locator("[data-side-panel]")).toHaveCount(0);
  await waiting.click();
  focus = await wentInto(page, "run", "species counts");
  await expect(focus.locator('[data-graph-waiting="idle"]')).toContainText("Not run yet");
  await focus.getByRole("button", { name: "The workflow" }).click();
  await wentInto(page, "resource", "species counts");
  await backToGraph(page);
  await graph.locator('[data-graph-planned="true"]').filter({ hasText: "Long petals" }).click();
  focus = await wentInto(page, "planned", "Long petals");
  await expect(focus.locator('[data-graph-view="planned"]')).toContainText("Planned, not made yet");
  await backToGraph(page);

  // The chat is as it was, on the same page, ready to be written in.
  expect(await page.locator("[data-message-seq]").count()).toBe(said);
  expect(new URL(page.url()).pathname).toBe(address);
  await expect(page.getByPlaceholder(/Ask Texera/)).toBeEditable();

  // The same things are a list a click away, and a row there goes in the same way.
  await page.locator('[data-resource-view="list"]').click();
  await expect(page.locator("[data-chat-tree]")).toBeVisible();
  await page
    .locator('[data-tree-resource="workflow"]')
    .filter({ hasText: "petal means" })
    .locator("[data-open-row]")
    .first()
    .click();
  focus = await wentInto(page, "resource", "petal means");
  await expect(focus.locator('[data-graph-crumb="root"]')).toHaveText("List");
  await focus.locator('[data-graph-crumb="root"]').click();
  await expect(page.locator("[data-graph-focus]")).toHaveCount(0);
  await expect(page.locator("[data-chat-tree]")).toBeVisible();
});
