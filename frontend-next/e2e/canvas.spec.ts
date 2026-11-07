import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, type Caller, cleanups, discard, editOperator, type Envelope, IRIS_CSV, operatorCard, operatorList, pick, signIn, tidyUp } from "./support";

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
    // With another reader: placed so that most stands under avg in avg's column.
    ...(beside ? { layout: { scan: { x: 40, y: 104 }, avg: { x: 360, y: 40 }, most: { x: 360, y: 168 } } } : {}),
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
  (await alice("GET", `/workflows/${rid}`)).spec.operators as {
    operatorID: string;
    operatorType: string;
    operatorProperties: Record<string, unknown>;
    customDisplayName?: string;
    viewResult?: boolean;
    isDisabled?: boolean;
  }[];

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

test("several cards are picked at once and go with one key, and Ctrl+Z brings them back with their arrows", async ({ page, request }) => {
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "pick several", { beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
  const picked = page.locator(".react-flow__node.selected");
  const avg = operatorCard(page, "avg");
  const most = operatorCard(page, "most");

  // A click picks one card; with Ctrl (Cmd on a Mac) a second joins it, and the two stay picked.
  await avg.click({ position: { x: 100, y: 14 } });
  await most.click({ position: { x: 100, y: 14 }, modifiers: ["ControlOrMeta"] });
  await expect(picked).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(picked).toHaveCount(2);
  // One press of Backspace removes both, and the arrows into them; the catalog's next version says so.
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect.poll(async () => (await operatorsOf(alice, rid)).map(o => o.operatorID), { timeout: 20_000 }).toEqual(["scan"]);

  // Ctrl+Z takes it back, the arrows included, and Ctrl+Shift+Z does it again.
  await expect(page.locator("[data-undo]")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect.poll(async () => (await operatorsOf(alice, rid)).map(o => o.operatorID).sort(), { timeout: 20_000 }).toEqual(["avg", "most", "scan"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.locator("[data-undo]").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  // A box drawn with Shift picks every card in it; Delete removes them all.
  const pane = await box(page.locator(".react-flow__pane"));
  await page.keyboard.down("Shift");
  await page.mouse.move(pane.x + 5, pane.y + 60);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 10, pane.y + pane.height - 10, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(picked).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

test("a new operator opens ready to set: typing and Backspace edit its setting, never remove it, and it says what it lacks", async ({ page, request }) => {
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "new card");
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
  const palette = await operatorList(page);
  await palette.getByPlaceholder("Search operators").fill("Limit");
  await palette.locator('[data-palette-operator="Limit"]').click();
  const limit = page.locator('.react-flow__node:has([data-operator-type="Limit"])');
  await expect(limit.locator("[data-operator-editor]")).toBeVisible();
  // The keyboard is in the card's first setting, not on the list it came from.
  await expect(limit.locator("[data-operator-editor] form input").first()).toBeFocused();
  await page.keyboard.type("25");
  await page.keyboard.press("Backspace");
  await expect(limit).toHaveCount(1);
  await expect(limit.locator("[data-operator-editor] form input").first()).toHaveValue("2");
  // Backspace anywhere in the open card is the card's.
  await limit.locator("[data-operator-editor]").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Backspace");
  await expect(limit).toHaveCount(1);
  await page.keyboard.press("Escape");
  // Not linked to anything, it says so in words.
  await expect(limit.locator("[data-operator-error]")).toHaveText("Needs an input: link an operator to it.");
  await expect.poll(async () => (await operatorsOf(alice, rid)).find(o => o.operatorType === "Limit")?.operatorProperties, { timeout: 20_000 }).toEqual({ limit: 2 });
});

test("a setting that names a column offers the columns its input has", async ({ page, request }) => {
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "columns");
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const editor = await editOperator(page, "avg");
  // The aggregation's column is picked from the scan's columns, each with its type.
  const options = editor.locator("select option");
  await expect(options.filter({ hasText: "PetalLengthCm · double" })).toHaveCount(1);
  await expect(options.filter({ hasText: "Species · string" }).first()).toBeAttached();
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

test("Tidy up lays a workflow out left to right: a join stands between its branches, and no card lies on an arrow", async ({ page, request }) => {
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `tidy ${stamp}`, spec: {} });
  const op = (id: string, operatorType: string) => ({ operatorID: id, operatorType, operatorProperties: {} });
  const link = (id: string, from: string, to: string, port = "input-0") => ({ linkID: id, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: port } });
  // Placed as the old layout placed them: the arrow from right to join runs over the filter.
  const workflow: Envelope = await alice("POST", "/workflows", {
    name: `tidy ${stamp}`,
    parent: project.metadata.rid,
    spec: {
      operators: [op("left", "CSVFileScan"), op("right", "CSVFileScan"), op("filter", "Filter"), op("join", "HashJoin")],
      links: [link("l1", "left", "filter"), link("l2", "filter", "join"), link("l3", "right", "join", "input-1")],
      layout: { left: { x: 40, y: 40 }, right: { x: 40, y: 168 }, filter: { x: 360, y: 40 }, join: { x: 680, y: 40 } },
    },
  });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await expect(operatorCard(page, "join")).toBeVisible();
  // The join lists no ports: it has the two its links use, and every arrow is drawn.
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  /** Whether the straight line from one card's output to another's input crosses a third card. */
  const crosses = async (from: string, to: string, over: string) => {
    const [a, b, c] = [await box(operatorCard(page, from)), await box(operatorCard(page, to)), await box(operatorCard(page, over))];
    const [x0, y0, x1, y1] = [a.x + a.width, a.y + a.height / 2, b.x, b.y + b.height / 2];
    for (let t = 0; t <= 1; t += 0.01) {
      const [x, y] = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
      if (x > c.x && x < c.x + c.width && y > c.y && y < c.y + c.height) return true;
    }
    return false;
  };
  expect(await crosses("right", "join", "filter")).toBe(true);

  await page.locator("[data-tidy]").click();
  await expect.poll(() => crosses("right", "join", "filter")).toBe(false);
  // The join stands between its two branches, right of both.
  const [filter, right, join] = [await box(operatorCard(page, "filter")), await box(operatorCard(page, "right")), await box(operatorCard(page, "join"))];
  expect(join.y).toBeGreaterThanOrEqual(Math.min(filter.y, right.y) - 1);
  expect(join.y).toBeLessThanOrEqual(Math.max(filter.y, right.y) + 1);
  expect(join.x).toBeGreaterThan(filter.x + filter.width);
  await page.screenshot({ path: "test-results/canvas-tidy.png" });
  // A tidy-up is a move: no version.
  await page.waitForTimeout(2500);
  expect((await alice("GET", `/workflows/${workflow.metadata.rid}`)).metadata.head).toBe(1);
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

test("the results float in a window over the canvas, named as their cards and pointing them out; it moves, folds and stays where it was put", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "results window", { beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
  await page.locator("[data-run]").click();
  const results = page.locator("[data-results]");
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  // A window over the canvas, not a panel under it; the canvas keeps its whole height.
  await expect(results).toHaveAttribute("data-results-window", "open");
  const canvas = await box(page.locator("[data-workflow-canvas]"));
  const window = await box(results);
  expect(window.y + window.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  expect(window.y).toBeGreaterThan(canvas.y);
  // Two aggregates are told apart: each result says what its operator does, as its card does.
  const avgTab = results.locator('[data-result-tab="avg:output-0"]');
  const mostTab = results.locator('[data-result-tab="most:output-0"]');
  await expect(avgTab).toContainText("average PetalLengthCm");
  await expect(mostTab).toContainText("max PetalLengthCm");
  await expect(avgTab.locator("img")).toHaveAttribute("src", /Aggregate/);
  // Pointing at a result points its card out; leaving it, no more.
  await mostTab.hover();
  await expect(operatorCard(page, "most").locator("[data-pointed]")).toHaveAttribute("data-pointed", "true");
  await expect(operatorCard(page, "avg").locator("[data-pointed]")).toHaveCount(0);
  await page.locator("[data-results-title]").hover();
  await expect(page.locator("[data-pointed]")).toHaveCount(0);
  // No card lies under the window when it opens on a canvas nobody moved.
  for (const id of ["scan", "avg", "most"]) expect(await overlap(operatorCard(page, id), results)).toBe(false);

  // Moved by its title bar, it stays where it was put, also after a reload.
  const title = await box(page.locator("[data-results-title]"));
  await page.mouse.move(title.x + 260, title.y + 12);
  await page.mouse.down();
  await page.mouse.move(title.x + 460, title.y + 12 - 120, { steps: 8 });
  await page.mouse.up();
  // It is held by its bottom left corner: that corner went where the pointer took it.
  const moved = await box(results);
  const before = await box(results.locator("[data-results-title]"));
  expect(Math.round(moved.x - window.x)).toBe(200);
  expect(Math.round(before.y - title.y)).toBe(-120);
  await page.reload();
  await expect(results.locator("[data-port-rows]")).toBeVisible();
  const kept = await box(results);
  expect([Math.round(kept.x), Math.round(kept.y + kept.height)]).toEqual([Math.round(moved.x), Math.round(moved.y + moved.height)]);
  // Folded to its title bar, and back.
  await page.locator("[data-fold-results]").click();
  await expect(results).toHaveAttribute("data-results-window", "folded");
  await expect(results.locator("[data-result-tab]")).toHaveCount(0);
  await page.locator("[data-fold-results]").click();
  await expect(results.locator("[data-result-tab]")).toHaveCount(2);
  // A double click on its title bar puts it back where it started.
  await page.locator("[data-results-title] >> text=Results").dblclick();
  await expect.poll(async () => Math.round((await box(results)).x)).toBe(Math.round(window.x));

  // Once the workflow moves on, the window says which version the results are of.
  await operatorCard(page, "most").click({ position: { x: 100, y: 14 } });
  await page.keyboard.press("Delete");
  await expect(results.locator("[data-ran-version]")).toHaveText("ran v1", { timeout: 20_000 });
});

test("the bar says where a run goes, and it goes there: on a unit made from a profile, results in the warehouse picked", async ({ page, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const { project, rid } = await irisWorkflow(alice, "where it runs");
  const lab: Envelope = await alice("POST", "/warehouses", { name: `lab ${Date.now()}`, parent: project, spec: {} });
  cleanups.push(async () => {
    // A warehouse goes once nothing keeps results in it: the executions first.
    const executions = await alice("GET", `/workflows/${rid}/executions?limit=50`);
    for (const x of executions.items as Envelope[]) await alice.attempt("DELETE", `/workflows/${rid}/executions/${x.metadata.rid}`);
    await alice.attempt("DELETE", `/resources/${lab.metadata.rid}`);
  });
  const defaults = (await alice("GET", "/settings")).spec.defaults;
  const profile = await alice("GET", defaults.profile.replace("texera://", "/"));
  const platform = await alice("GET", defaults.warehouse.replace("texera://", "/"));
  await signIn(page);
  await page.goto(`/workflows/${rid}`);

  // On the unit (made from its profile), results in the platform's warehouse unless another is picked.
  const target = page.locator("[data-run-target]");
  await expect(target.locator("[data-run-profile]")).toContainText(profile.metadata.name);
  await expect(target.getByLabel("Warehouse")).toHaveText(platform.metadata.name);
  await pick(page, target.getByLabel("Warehouse"), lab.metadata.name);
  await page.screenshot({ path: "test-results/run-target.png" });
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  const [ran] = (await alice("GET", `/workflows/${rid}/executions?limit=1`)).items;
  expect(ran.spec.warehouse).toBe(lab.metadata.uri);
  expect(ran.spec.computing.profile.split("@")[0]).toBe(defaults.profile);

  // Its page says where it ran and what the unit had, each package as installed.
  await page.goto(`/workflows/${rid}/executions/${ran.metadata.rid}`);
  const execution = page.locator("[data-execution-view]");
  await execution.getByRole("tab", { name: "Details" }).click();
  await expect(execution.locator("[data-execution-computing] [data-ran-on]")).toContainText(`(${profile.metadata.name} v`);
  await expect(execution.locator("[data-execution-computing] [data-ran-on]")).toContainText(`results in ${lab.metadata.name}`);
  await expect(execution.locator("[data-execution-packages]")).toContainText("pandas==");
  // So does its card in lineage: the unit and the warehouse are no cards of their own there.
  await execution.getByRole("tab", { name: "Lineage" }).click();
  await expect(page.locator('[data-lineage-card="execution"][data-root] [data-ran-on]')).toContainText(lab.metadata.name);
  await page.screenshot({ path: "test-results/run-target-lineage.png" });
});

// Where a run goes is proposed as the catalog decides it for anyone's run, the agent's in a chat
// included: the workflow's unit, else its project's, else the platform's. A unit picked in the
// bar is for this page's runs and is not remembered past it.
test("the bar proposes the workflow's own unit, else the platform's, and a pick is the page's alone", async ({ page, request }) => {
  const alice = await api(request);
  const defaults = (await alice("GET", "/settings")).spec.defaults;
  const platform: Envelope & { spec: { endpoint?: string; clientId?: string } } = await alice("GET", defaults.computingUnit.replace("texera://", "/"));
  const { endpoint, clientId } = platform.spec;
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `its own unit ${stamp}`, spec: {} });
  const own: Envelope = await alice("POST", "/computing-units", { name: `its own ${stamp}`, parent: project.metadata.rid, spec: { provider: "static", endpoint, ...(clientId ? { clientId } : {}) } });
  const scan = { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: "", fileEncoding: "UTF_8", hasHeader: true } };
  const workflow: Envelope = await alice("POST", "/workflows", { name: `its own unit ${stamp}`, parent: project.metadata.rid, spec: { operators: [scan], links: [] } });
  const rid = workflow.metadata.rid;
  // The workflow names the unit, so it goes first, then the unit, then the project they were in.
  cleanups.push(async () => {
    await discard(alice, [rid], [own.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  await signIn(page);
  const unit = page.locator("[data-run-target]").getByLabel("Computing unit");

  // Naming none, the workflow runs on the platform's unit; a pick holds for the page.
  await page.goto(`/workflows/${rid}`);
  await expect(unit).toHaveText(platform.metadata.name);
  await pick(page, unit, own.metadata.name);
  await expect(unit).toHaveText(own.metadata.name);
  await page.reload();
  await expect(unit).toHaveText(platform.metadata.name);

  // A workflow that names its unit is proposed it.
  const head = await alice("GET", `/workflows/${rid}`);
  await alice("PUT", `/workflows/${rid}`, { spec: { ...head.spec, defaultComputingUnit: own.metadata.uri } });
  await page.reload();
  await expect(unit).toHaveText(own.metadata.name);
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
