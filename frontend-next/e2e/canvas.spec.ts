import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, type Caller, cleanups, discard, editOperator, type Envelope, IRIS_CSV, operatorCard, signIn, tidyUp } from "./support";

// The canvas: an operator is a card that says how it is set, in one line or with every setting
// on its own, and is edited in place, the cards under it making room; arrows are curves. Each
// card has the operator's own two buttons: the eye keeps its result on every run, and the run
// button runs up to it. An execution shows on the canvas of the workflow that ran: each card
// says where its operator stands and the rows it read and put out; under the canvas each kept
// result has a tab; a click on a card shows its result and lights the port it came out of. A
// visualization's result is the chart it drew.

test.afterEach(tidyUp);

/**
 * A project of alice's with the iris flowers and a workflow over them: scan, average per
 * species, and a chart of it when asked. The average's result is kept; the scan's when asked.
 */
async function irisWorkflow(alice: Caller, label: string, { chart = false, keepScan = false, beside = false } = {}) {
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `${label} ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "Fisher's iris flowers" });
  const link = (id: string, from: string, to: string) => ({ linkID: id, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: "input-0" } });
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", viewResult: keepScan, operatorProperties: { fileName: `${dataset.metadata.uri}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
      ...(chart ? [{ operatorID: "chart", operatorType: "BarChart", viewResult: true, operatorProperties: { fields: "Species", value: "avg", horizontalOrientation: false } }] : []),
      // Another reader of the scan, laid out under avg in the same column.
      ...(beside ? [{ operatorID: "most", operatorType: "Aggregate", operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "max", attribute: "PetalLengthCm", "result attribute": "most" }] } }] : []),
    ],
    links: [link("l1", "scan", "avg"), ...(chart ? [link("l2", "avg", "chart")] : []), ...(beside ? [link("l3", "scan", "most")] : [])],
  };
  const workflow: Envelope = await alice("POST", "/workflows", { name: `${label} ${stamp}`, parent: project.metadata.rid, spec });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  return { project: project.metadata.rid, rid: workflow.metadata.rid, name: workflow.metadata.name };
}

/** The output port of an operator, as its card draws it. */
const portOf = (page: Page, operator: string) => operatorCard(page, operator).locator(".react-flow__handle.source").first();

/** Where a thing is on screen. */
const box = async (of: Locator) => (await of.boundingBox()) as { x: number; y: number; width: number; height: number };

/** Whether two things on the page lie over each other. */
async function overlap(a: Locator, b: Locator) {
  const [p, q] = [await a.boundingBox(), await b.boundingBox()];
  if (!p || !q) throw new Error("one of them is not on the page");
  return p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y;
}

/** The operators of a workflow as the catalog has it now. */
const operatorsOf = async (alice: Caller, rid: string) =>
  (await alice("GET", `/workflows/${rid}`)).spec.operators as { operatorID: string; customDisplayName?: string; viewResult?: boolean; isDisabled?: boolean }[];

test("an operator is a card that says its settings, keeps its result at a click on its eye, and is edited in place", async ({ page, request }) => {
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "cards", { beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const scan = operatorCard(page, "scan");
  const avg = operatorCard(page, "avg");
  const most = operatorCard(page, "most");
  await expect(avg).toBeVisible();

  // In one line: the operator's name, and its settings as a person would say them. A file is
  // its name, not its address.
  await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-density", "compact");
  await expect(scan).toContainText("CSV File Scan");
  await expect(scan.locator("[data-operator-summary]")).toHaveText("iris.csv");
  await expect(avg.locator("[data-operator-summary]")).toHaveText("average PetalLengthCm avg · Species");
  await expect(avg.locator("[data-operator-settings]")).toHaveCount(0);
  // The arrow between them is a curve.
  await expect(page.locator(".react-flow__edge-path").first()).toHaveAttribute("d", /C/);

  // Every setting on a line of its own, for the whole canvas, as the viewer chooses; the choice
  // is kept for the next visit.
  await page.locator('[data-segment="detailed"]').click();
  await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-density", "detailed");
  await expect(avg.locator("[data-operator-settings]")).toContainText("Group By Keys");
  await expect(scan.locator("[data-operator-settings]")).toContainText("iris.csv");
  await page.screenshot({ path: "test-results/canvas-detailed.png" });
  await page.reload();
  await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-density", "detailed");
  await page.locator('[data-segment="compact"]').click();

  // The eye: avg keeps its result, and says so without being pointed at; scan does not, and its
  // eye shows only when the card is pointed at. A click turns it on or off, in the workflow.
  await expect(avg.locator("[data-operator-eye]")).toHaveAttribute("data-operator-eye", "on");
  await expect(avg.locator("[data-operator-eye]")).toBeVisible();
  await expect(scan.locator("[data-operator-eye]")).toBeHidden();
  // Until then the name has the card's whole width.
  await expect(scan.locator("[data-operator-run]")).toBeHidden();
  await scan.hover();
  await expect(scan.locator("[data-operator-eye]")).toBeVisible();
  await scan.locator("[data-operator-eye]").click();
  await expect(scan.locator("[data-operator-eye]")).toHaveAttribute("data-operator-eye", "on");
  await expect.poll(async () => (await operatorsOf(alice, rid)).find(o => o.operatorID === "scan")?.viewResult, { timeout: 20_000 }).toBe(true);
  await scan.locator("[data-operator-eye]").click();
  await expect.poll(async () => (await operatorsOf(alice, rid)).find(o => o.operatorID === "scan")?.viewResult ?? false, { timeout: 20_000 }).toBe(false);

  // Edited where it is: the card opens into its form, within its column; no panel opens beside
  // the canvas. The card under it makes room, and goes back when the card closes.
  const under = await box(most);
  const editor = await editOperator(page, "avg");
  await expect(avg.locator("[data-operator-view]")).toHaveAttribute("data-operator-view", "editing");
  await expect(page.locator("[data-property-panel]")).toHaveCount(0);
  expect((await box(avg)).width).toBeLessThanOrEqual(300);
  await expect.poll(() => overlap(avg, most)).toBe(false);
  expect((await box(most)).y).toBeGreaterThan(under.y);
  await editor.getByLabel("Operator name").fill("mean petal");
  await page.screenshot({ path: "test-results/canvas-editing.png" });
  await page.locator("[data-operator-done]").click();
  await expect(avg.locator("[data-operator-editor]")).toHaveCount(0);
  await expect(avg).toContainText("mean petal");
  await expect.poll(async () => Math.round((await box(most)).y)).toBe(Math.round(under.y));
  await expect.poll(async () => (await operatorsOf(alice, rid)).find(o => o.operatorID === "avg")?.customDisplayName, { timeout: 20_000 }).toBe("mean petal");
  // A double click opens a card as its pencil does, and Escape closes it.
  await scan.dblclick({ position: { x: 60, y: 14 } });
  await expect(scan.locator("[data-operator-editor]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scan.locator("[data-operator-editor]")).toHaveCount(0);

  // What else can be done to an operator is on a right click: turn it off and on, delete it.
  await most.click({ button: "right" });
  await page.locator('[data-operator-menu="power"]').click();
  await expect(most).toContainText("Off");
  await expect.poll(async () => (await operatorsOf(alice, rid)).find(o => o.operatorID === "most")?.isDisabled, { timeout: 20_000 }).toBe(true);
  await most.click({ button: "right" });
  await page.locator('[data-operator-menu="delete"]').click();
  await expect(most).toHaveCount(0);
  await expect.poll(async () => (await operatorsOf(alice, rid)).map(o => o.operatorID).sort(), { timeout: 20_000 }).toEqual(["avg", "scan"]);
});

test("a workflow too large to see at once offers a map, which lies over the canvas only once the viewer opens it", async ({ page, request }) => {
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `canvas map ${stamp}`, spec: {} });
  // A scan and four chains after it: more rows and columns than a screen holds.
  const chains = Array.from({ length: 4 }, (_, c) => Array.from({ length: 4 }, (_, i) => `limit${c}-${i}`));
  const link = (from: string, to: string) => ({ linkID: `${from}>${to}`, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: "input-0" } });
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: "", fileEncoding: "UTF_8", hasHeader: true } },
      ...chains.flat().map((id, i) => ({ operatorID: id, operatorType: "Limit", operatorProperties: { limit: 100 - i } })),
    ],
    links: chains.flatMap(chain => chain.map((id, i) => link(i === 0 ? "scan" : (chain[i - 1] as string), id))),
  };
  const workflow: Envelope = await alice("POST", "/workflows", { name: `canvas map ${stamp}`, parent: project.metadata.rid, spec });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  const map = page.locator(".react-flow__minimap");
  const toggle = page.locator("[data-canvas-map]");
  /** What the map lies over, of the given things. */
  const under = (things: string) =>
    page.evaluate(selector => {
      const box = document.querySelector(".react-flow__minimap")?.getBoundingClientRect();
      if (!box) return ["no map"];
      return Array.from(document.querySelectorAll(selector))
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
        })
        .map(el => el.getAttribute("data-id") ?? el.className.toString().slice(0, 40));
    }, things);

  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await expect(operatorCard(page, "scan")).toBeInViewport({ ratio: 0.99 });
  await expect(operatorCard(page, "limit0-3")).toBeVisible();
  // As it opens, nothing lies over the operators: the map is offered, not shown.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(map).toHaveCount(0);
  // Opened, it lies over the canvas where the viewer asked for it, and over none of the buttons.
  await toggle.click();
  await expect(map).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await under(".react-flow__controls, [data-add-operator], [data-segment]")).toEqual([]);
  await page.screenshot({ path: "test-results/canvas-map.png" });
  // The choice is the viewer's, kept for the next visit, and taken back the same way.
  await page.reload();
  await expect(map).toBeVisible();
  await toggle.click();
  await expect(map).toHaveCount(0);

  // A small workflow is seen whole: no map is offered.
  const small = await irisWorkflow(alice, "canvas no map");
  await page.goto(`/workflows/${small.rid}`);
  await expect(operatorCard(page, "avg")).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await expect(map).toHaveCount(0);
});

test("an execution shows on the workflow's canvas, a click on a card shows its result, and a run can go up to one operator", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "run on canvas", { keepScan: true, beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const scan = operatorCard(page, "scan");
  const avg = operatorCard(page, "avg");
  const most = operatorCard(page, "most");
  await expect(avg).toBeVisible();
  // Before any execution a card says nothing of one, and there are no results to show.
  await expect(avg.locator("[data-operator-execution]")).toHaveCount(0);
  await expect(page.locator("[data-results]")).toHaveCount(0);

  // Run: the page stays where it is, and the cards say how each operator did: the rows a source
  // put out, the rows any other read and put out.
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(scan.locator("[data-operator-status]")).toHaveAttribute("data-operator-status", "completed");
  await expect(scan.locator("[data-operator-rows]")).toHaveText("150 rows");
  await expect(avg.locator("[data-operator-rows]")).toHaveText("150 → 3 rows");

  // The results kept are under the canvas: scan's and avg's, which have their eye on, and most's,
  // which nothing reads from. One tab each; there is no line from a tab to its port.
  const results = page.locator("[data-results]");
  await expect(results.locator("[data-result-tab]")).toHaveCount(3);
  await expect(page.locator("[data-result-connector]")).toHaveCount(0);
  // A click on a card shows its result, rings the card and lights the port it came out of.
  await scan.click();
  await expect(results.locator('[data-result-tab="scan:output-0"]')).toHaveAttribute("aria-selected", "true");
  await expect(results.locator("[data-port-rows]")).toContainText("SepalLengthCm");
  await expect(scan.locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
  await expect(portOf(page, "scan")).toHaveAttribute("data-result", "shown");
  await expect(portOf(page, "avg")).toHaveAttribute("data-result", "kept");
  await page.screenshot({ path: "test-results/canvas-results.png" });
  // And a tab puts its operator's card in the ring and lights its port.
  await results.locator('[data-result-tab="avg:output-0"]').click();
  await expect(avg.locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
  await expect(portOf(page, "avg")).toHaveAttribute("data-result", "shown");
  await expect(portOf(page, "scan")).toHaveAttribute("data-result", "kept");
  await expect(results.locator("[data-port-rows]")).toContainText("Iris-setosa");
  // More rows than a page holds: the way to the next page stands clear of the button of the
  // chat beside the page, which floats over that corner.
  await scan.click();
  const next = results.getByLabel("Next page");
  await expect(next).toBeVisible();
  expect(await overlap(next, page.locator("[data-chat-dock-button]"))).toBe(false);
  await next.click();
  await expect(results.getByText("2 / 3")).toBeVisible();

  // The results fold away and come back.
  await page.getByLabel("Hide the results").click();
  await expect(results).toHaveCount(0);
  await page.locator("[data-show-results]").click();
  await expect(results.locator("[data-port-rows]")).toBeVisible();

  // Run again, the same version on the same unit: a second execution starts, takes over the
  // cards and the results, and has a name of its own.
  const first = await results.getAttribute("data-results");
  await page.locator("[data-run]").click();
  await expect.poll(() => page.locator("[data-results]").getAttribute("data-results"), { timeout: 30_000 }).not.toBe(first);
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(avg.locator("[data-operator-rows]")).toHaveText("150 → 3 rows");

  // Run up to most, from its card: only what leads to it runs, its result is on screen, and the
  // workflow is as it was.
  const head = (await alice("GET", `/workflows/${rid}`)).metadata.head;
  await most.hover();
  await most.locator("[data-operator-run]").click();
  await expect.poll(() => page.locator("[data-results]").getAttribute("data-results"), { timeout: 30_000 }).not.toBe(first);
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(most.locator("[data-operator-status]")).toHaveAttribute("data-operator-status", "completed");
  await expect(avg.locator("[data-operator-execution]")).toHaveCount(0);
  await expect(results.locator('[data-result-tab="most:output-0"]')).toHaveAttribute("aria-selected", "true");
  await expect(results.locator('[data-result-tab="avg:output-0"]')).toHaveCount(0);
  await expect(results.locator("[data-port-rows]")).toContainText("most");
  const executions = (await alice("GET", `/workflows/${rid}/executions?limit=10`)).items as { metadata: { name: string }; spec: { upTo?: string } }[];
  expect(executions).toHaveLength(3);
  expect(new Set(executions.map(x => x.metadata.name)).size).toBe(3);
  expect(executions[0]?.spec.upTo).toBe("most");
  expect((await alice("GET", `/workflows/${rid}`)).metadata.head).toBe(head);
});

test("an execution's page is the workflow as it ran, and a visualization's result is the chart it drew", async ({ page, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const { rid, name } = await irisWorkflow(alice, "chart", { chart: true });
  const execution = await alice("POST", `/workflows/${rid}/run`, { waitSeconds: 180, name: `${name}, charted` });
  expect(execution.status.phase).toBe("completed");
  await signIn(page);
  await page.goto(`/workflows/${rid}/executions/${execution.metadata.rid}`);
  const stage = page.locator("[data-execution-stage]");

  // The workflow as it ran, each card saying how its operator did.
  await expect(operatorCard(page, "chart")).toBeVisible();
  await expect(stage.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "false");
  await expect(operatorCard(page, "avg").locator("[data-operator-rows]")).toHaveText("150 → 3 rows");
  await expect(operatorCard(page, "scan").locator("[data-operator-edit]")).toHaveCount(0);

  // The result on screen is the last one kept: the chart. It is a picture, not a table of its
  // HTML, and its tab says so.
  const chart = stage.locator('[data-result-tab="chart:output-0"]');
  await expect(chart).toHaveAttribute("aria-selected", "true");
  await expect(chart).toHaveAttribute("data-result-kind", "chart");
  await expect(stage.locator("[data-port-chart] iframe")).toBeVisible();
  await expect(stage.locator("[data-port-rows]")).toHaveCount(0);
  // What the operator drew is in the frame, whole.
  await expect(page.frameLocator("[data-port-chart] iframe").locator(".plotly-graph-div")).toHaveCount(1, { timeout: 30_000 });
  await expect(portOf(page, "chart")).toHaveAttribute("data-result", "shown");
  await page.screenshot({ path: "test-results/execution-chart.png" });

  // Another tab and back, right after the cards changed size: the canvas is still there to see.
  const noPlace: string[] = [];
  page.on("console", message => {
    if (message.text().includes("NaN")) noPlace.push(message.text());
  });
  await page.locator('[data-segment="detailed"]').click();
  await page.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByText("As the catalog has it")).toBeVisible();
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(operatorCard(page, "chart")).toBeInViewport();
  await expect(operatorCard(page, "chart").locator("[data-operator-settings]")).toBeVisible();
  await page.locator('[data-segment="compact"]').click();
  await expect(operatorCard(page, "chart")).toBeInViewport();
  expect(noPlace).toEqual([]);

  // The table it was drawn from is a click on its card away, its port lit.
  await operatorCard(page, "avg").click();
  await expect(stage.locator('[data-result-tab="avg:output-0"]')).toHaveAttribute("aria-selected", "true");
  await expect(stage.locator('[data-result-tab="avg:output-0"]')).toHaveAttribute("data-result-kind", "table");
  await expect(stage.locator("[data-port-rows]")).toContainText("Iris-virginica");
  await expect(portOf(page, "avg")).toHaveAttribute("data-result", "shown");
});
