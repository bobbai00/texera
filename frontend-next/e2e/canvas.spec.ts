import { expect, type Locator, test } from "@playwright/test";
import { api, type Caller, cleanups, discard, editOperator, type Envelope, IRIS_CSV, operatorCard, operatorList, pick, signIn, tidyUp, withIris } from "./support";

// The canvas: an operator is a card that says how it is set, in one line or with every setting
// on its own, and is edited in place, the cards under it making room; arrows are curves. Each
// card has the operator's own two buttons: the eye keeps its result on every run, and the run
// button runs up to it. An execution shows on the canvas of the workflow that ran: each card
// says where its operator stands and the rows it read and put out; each result it kept is a
// cylinder under the card, joined to its port by a dashed line, which opens the table in a
// window. A result of an earlier version whose operator changed since says so. A visualization's
// result is the chart it drew.

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
  // Back where it was, to the pixel a zoomed canvas rounds it to.
  await expect.poll(async () => Math.abs((await box(most)).y - under.y)).toBeLessThanOrEqual(1);
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
  const picked = page.locator(".react-flow__node-operator.selected");
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
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge:not([data-id^='resource:'])")).toHaveCount(0);
  await expect.poll(async () => (await operatorsOf(alice, rid)).map(o => o.operatorID), { timeout: 20_000 }).toEqual(["scan"]);

  // Ctrl+Z takes it back, the arrows included, and Ctrl+Shift+Z does it again.
  await expect(page.locator("[data-undo]")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge:not([data-id^='resource:'])")).toHaveCount(2);
  await expect.poll(async () => (await operatorsOf(alice, rid)).map(o => o.operatorID).sort(), { timeout: 20_000 }).toEqual(["avg", "most", "scan"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(1);
  await page.locator("[data-undo]").click();
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(3);

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
  await expect(page.locator(".react-flow__node-operator")).toHaveCount(0);
});

// The page shows the head while the workflow's live session is being joined, and a card can be
// picked then. Joining gives the canvas the live document to read in the head's place: the pick
// stays, and the page with it (the two once answered each other without end, and the page fell).
test("a card picked while the workflow's live session is still being joined stays picked once it is", async ({ page, request }) => {
  const as = await api(request);
  const spec = { operators: [{ operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 5 } }], links: [] };
  const workflow: Envelope = await as("POST", "/workflows", { name: `pick while joining ${Date.now()}`, spec });
  cleanups.push(() => discard(as, [workflow.metadata.rid]));
  await signIn(page);
  // The session's socket is held back until the card is picked, however fast the stack answers;
  // what the page says meanwhile is kept and sent on.
  let join = () => {};
  const held = new Promise<void>(resolve => {
    join = resolve;
  });
  await page.routeWebSocket(/\/live\/sessions/, async socket => {
    const early: (string | Buffer)[] = [];
    socket.onMessage(message => early.push(message));
    await held;
    const server = socket.connectToServer();
    for (const message of early) server.send(message);
    socket.onMessage(message => server.send(message));
  });
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  const canvas = page.locator("[data-workflow-canvas]");
  await expect(canvas).toHaveAttribute("data-editable", "false");
  const card = page.locator('.react-flow__node[data-id="limit"]');
  await card.click();
  await expect(card).toHaveClass(/selected/);

  join();
  await expect(canvas).toHaveAttribute("data-editable", "true");
  await expect(card).toHaveClass(/selected/);
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
  // The cards have their full size once the canvas has joined the workflow's live session.
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
  // The join lists no ports: it has the two its links use, and every arrow is drawn.
  await expect(page.locator(".react-flow__edge:not([data-id^='resource:'])")).toHaveCount(3);

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
  // As placed, once the cards have settled into their sizes.
  await expect.poll(() => crosses("right", "join", "filter")).toBe(true);

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

test("an execution shows on the workflow's canvas, each result a cylinder under its card that opens its table, and a run can go up to one operator", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "run on canvas", { keepScan: true, beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const scan = operatorCard(page, "scan");
  const avg = operatorCard(page, "avg");
  const most = operatorCard(page, "most");
  const latest = page.locator("[data-latest-execution]");
  await expect(avg).toBeVisible();
  // Before any execution a card says nothing of one, there is no result, and nothing to look at as an execution.
  await expect(avg.locator("[data-operator-execution]")).toHaveCount(0);
  await expect(page.locator("[data-result-chip]")).toHaveCount(0);
  await expect(page.locator('[data-segment="execution"]')).toBeDisabled();

  // Run: the page stays where it is, and the cards say how each operator did: the rows a source
  // put out, the rows any other read and put out.
  await page.locator("[data-run]").click();
  await expect(latest).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(scan.locator("[data-operator-status]")).toHaveAttribute("data-operator-status", "completed");
  await expect(scan.locator("[data-operator-rows]")).toHaveText("150 rows");
  await expect(avg.locator("[data-operator-rows]")).toHaveText("150 → 3 rows");

  // Each result kept is a cylinder under its card: scan's and avg's, which have their eye on, and
  // most's, which nothing reads from. No table is open until one is asked for.
  const chips = page.locator("[data-result-chip]");
  await expect(chips).toHaveCount(3);
  await expect(page.locator('[data-result-chip="scan:output-0"]')).toContainText("150 rows");
  await expect(page.locator('[data-result-chip="avg:output-0"]')).toContainText("3 rows");
  const chipOf = await box(page.locator('[data-result-chip="avg:output-0"]'));
  const cardOf = await box(avg);
  expect(chipOf.y).toBeGreaterThan(cardOf.y + cardOf.height);
  const results = page.locator("[data-results]");
  await expect(results).toHaveCount(0);
  // A click on a cylinder opens its table, says what it is, and rings the card it came out of.
  await page.locator('[data-result-chip="scan:output-0"]').click();
  await expect(results).toHaveAttribute("data-result-open", "scan:output-0");
  await expect(results.locator("[data-port-rows]")).toContainText("SepalLengthCm");
  await expect(results.locator("[data-result-about]")).toContainText("150 rows");
  await expect(results.locator("[data-result-about]")).toContainText("6 columns");
  await expect(scan.locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
  await expect(page.locator('[data-result-chip="scan:output-0"]')).toHaveAttribute("data-result-open", "true");
  await page.screenshot({ path: "test-results/canvas-results.png" });
  // A click on a card opens its result too.
  await avg.click();
  await expect(results).toHaveAttribute("data-result-open", "avg:output-0");
  await expect(avg.locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
  await expect(results.locator("[data-port-rows]")).toContainText("Iris-setosa");
  // More rows than a page holds: the way to the next page stands clear of the button of the
  // chat beside the page, which floats over that corner.
  await page.locator('[data-result-chip="scan:output-0"]').click();
  const next = results.getByLabel("Next page");
  await expect(next).toBeVisible();
  expect(await overlap(next, page.locator("[data-chat-dock-button]"))).toBe(false);
  await next.click();
  await expect(results.getByText("2 / 3")).toBeVisible();

  // The window closes; the cylinders stay. The viewer may hide them while editing.
  await page.locator("[data-close-result]").click();
  await expect(results).toHaveCount(0);
  await expect(chips).toHaveCount(3);
  await page.locator("[data-canvas-results]").click();
  await expect(chips).toHaveCount(0);
  await page.locator("[data-canvas-results]").click();
  await expect(chips).toHaveCount(3);

  // Run again, the same version on the same unit: a second execution starts, takes over the
  // cards and the cylinders, and has a name of its own.
  const first = await latest.getAttribute("data-execution");
  await page.locator("[data-run]").click();
  await expect(latest).not.toHaveAttribute("data-execution", first ?? "", { timeout: 30_000 });
  await expect(latest).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(avg.locator("[data-operator-rows]")).toHaveText("150 → 3 rows");
  await page.locator('[data-result-chip="avg:output-0"]').click();
  await expect(results).toHaveAttribute("data-results", (await latest.getAttribute("data-execution")) ?? "");
  await page.locator("[data-close-result]").click();

  // Run up to most, from its card: only what leads to it runs, its result opens, and the
  // workflow is as it was.
  const second = await latest.getAttribute("data-execution");
  const head = (await alice("GET", `/workflows/${rid}`)).metadata.head;
  await most.hover();
  await most.locator("[data-operator-run]").click();
  await expect(latest).not.toHaveAttribute("data-execution", second ?? "", { timeout: 30_000 });
  await expect(latest).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  await expect(most.locator("[data-operator-status]")).toHaveAttribute("data-operator-status", "completed");
  await expect(avg.locator("[data-operator-execution]")).toHaveCount(0);
  await expect(results).toHaveAttribute("data-result-open", "most:output-0");
  await expect(page.locator('[data-result-chip="avg:output-0"]')).toHaveCount(0);
  await expect(results.locator("[data-port-rows]")).toContainText("most");
  const executions = (await alice("GET", `/workflows/${rid}/executions?limit=10`)).items as { metadata: { name: string }; spec: { upTo?: string } }[];
  expect(executions).toHaveLength(3);
  expect(new Set(executions.map(x => x.metadata.name)).size).toBe(3);
  expect(executions[0]?.spec.upTo).toBe("most");
  expect((await alice("GET", `/workflows/${rid}`)).metadata.head).toBe(head);
});

test("a result opens in a window over the canvas, named as its card and pointing it out; it moves, folds and stays where it was put", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "results window", { beside: true });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  const results = page.locator("[data-results]");
  await page.locator('[data-result-chip="avg:output-0"]').click();
  // A window over the canvas, not a panel under it; the canvas keeps its whole height.
  await expect(results).toHaveAttribute("data-results-window", "open");
  const canvas = await box(page.locator("[data-workflow-canvas]"));
  const window = await box(results);
  expect(window.y + window.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  expect(window.y).toBeGreaterThan(canvas.y);
  // Named as its card names it, with what the operator does: two aggregates are told apart.
  const title = results.locator("[data-results-title]");
  await expect(title).toContainText("average PetalLengthCm");
  await expect(title.locator("img")).toHaveAttribute("src", /Aggregate/);
  // A window open may lie over results lower on a small screen: it closes, and another opens.
  await page.locator("[data-close-result]").click();
  await page.locator('[data-result-chip="most:output-0"]').click();
  await expect(title).toContainText("max PetalLengthCm");
  // Pointing at the window points its card out; leaving it, no more.
  await title.hover();
  await expect(operatorCard(page, "most").locator("[data-pointed]")).toHaveAttribute("data-pointed", "true");
  await expect(operatorCard(page, "avg").locator("[data-pointed]")).toHaveCount(0);
  await page.mouse.move(canvas.x + 4, canvas.y + 4);
  await expect(page.locator("[data-pointed]")).toHaveCount(0);
  // No card lies under the window when it opens on a canvas nobody moved.
  for (const id of ["scan", "avg", "most"]) expect(await overlap(operatorCard(page, id), results)).toBe(false);

  // Moved by its title bar, it stays where it was put, also after a reload.
  const bar = await box(title);
  await page.mouse.move(bar.x + 8, bar.y + 12);
  await page.mouse.down();
  await page.mouse.move(bar.x + 208, bar.y + 12 - 120, { steps: 8 });
  await page.mouse.up();
  // It is held by its bottom left corner: that corner went where the pointer took it.
  const moved = await box(results);
  const before = await box(title);
  expect(Math.round(moved.x - window.x)).toBe(200);
  expect(Math.round(before.y - bar.y)).toBe(-120);
  await page.reload();
  await page.locator('[data-result-chip="most:output-0"]').click();
  await expect(results.locator("[data-port-rows]")).toBeVisible();
  const kept = await box(results);
  expect([Math.round(kept.x), Math.round(kept.y + kept.height)]).toEqual([Math.round(moved.x), Math.round(moved.y + moved.height)]);
  // Folded to its title bar, and back.
  await page.locator("[data-fold-results]").click();
  await expect(results).toHaveAttribute("data-results-window", "folded");
  await expect(results.locator("[data-port-rows]")).toHaveCount(0);
  await page.locator("[data-fold-results]").click();
  await expect(results.locator("[data-port-rows]")).toBeVisible();
  // A double click on its title bar puts it back where it started.
  await title.dblclick({ position: { x: 6, y: 12 } });
  await expect.poll(async () => Math.round((await box(results)).x)).toBe(Math.round(window.x));
});

test("once the workflow moves on, a result of the version that ran says so, and the execution can be looked at as it ran", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid } = await irisWorkflow(alice, "moved on", { beside: true });
  // Version 1 runs; version 2 asks avg for the max instead: avg's result is of version 1, most's still holds.
  const ran = await alice("POST", `/workflows/${rid}/run`, { waitSeconds: 180 });
  expect(ran.status.phase).toBe("completed");
  const wf = await alice("GET", `/workflows/${rid}`);
  const spec = structuredClone(wf.spec) as { operators: { operatorID: string; operatorProperties: { aggregations: { aggFunction: string }[] } }[] };
  const avgOp = spec.operators.find(o => o.operatorID === "avg");
  if (avgOp?.operatorProperties.aggregations[0]) avgOp.operatorProperties.aggregations[0].aggFunction = "max";
  await alice("PUT", `/workflows/${rid}`, { spec });
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  const stale = page.locator('[data-result-chip="avg:output-0"]');
  await expect(stale).toHaveAttribute("data-result-stale", "1");
  await expect(page.locator('[data-result-chip="most:output-0"]')).not.toHaveAttribute("data-result-stale", /./);
  // The changed operator's card says nothing of how it did then.
  await expect(operatorCard(page, "avg").locator("[data-operator-execution]")).toHaveCount(0);
  await expect(operatorCard(page, "most").locator("[data-operator-rows]")).toHaveText("150 → 3 rows");
  await stale.click();
  await expect(page.locator("[data-results] [data-result-stale]")).toHaveText("v1 · changed since");
  await page.screenshot({ path: "test-results/canvas-stale.png" });

  // Looked at as an execution: the version it ran, which cannot be edited, its results all as they were.
  await page.locator('[data-segment="execution"]').click();
  const stage = page.locator(`[data-execution-stage="${ran.metadata.rid}"]`);
  await expect(stage.locator("[data-workflow-canvas]")).toHaveAttribute("data-editable", "false");
  await expect(stage.locator('[data-result-chip="avg:output-0"]')).not.toHaveAttribute("data-result-stale", /./);
  await expect(stage.locator('.react-flow__node[data-id="avg"] [data-operator-rows]')).toHaveText("150 → 3 rows");
  await stage.locator('[data-result-chip="avg:output-0"]').click();
  await expect(stage.locator("[data-port-rows]")).toContainText("avg");
  await page.screenshot({ path: "test-results/canvas-execution-view.png" });
  // And back to editing the newest version.
  await page.locator('[data-segment="edit"]').click();
  await expect(page.locator('[data-workflow-canvas][data-editable="true"]')).toBeVisible();
});

test("a result is saved as a version of a dataset, which the lineage shows came of it", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const { rid, name, project } = await irisWorkflow(alice, "saved", { beside: true });
  const ran = await alice("POST", `/workflows/${rid}/run`, { waitSeconds: 180 });
  expect(ran.status.phase).toBe("completed");
  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await page.locator('[data-result-chip="avg:output-0"]').click();
  await page.locator("[data-save-result]").click();
  const form = page.locator("[data-save-result-form]");
  await expect(form.locator("[data-save-result-name]")).toHaveValue(`Aggregate of ${ran.metadata.name}`);
  // Typed in as a person does: a click puts the caret in the field (the window's title bar the
  // form opens from does not take the press), and the keys replace the name.
  await form.locator("[data-save-result-name]").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(`Petal means ${name}`);
  await expect(form.locator("[data-save-result-file]")).toHaveValue("aggregate.csv");
  await form.locator("[data-save-result-go]").click();
  await expect(form.locator("[data-result-saved]")).toContainText(`Petal means ${name} v1`);
  await page.screenshot({ path: "test-results/canvas-saved.png" });
  // Again, into the dataset just made, picked from the list with the pointer: its version 2.
  await page.keyboard.press("Escape");
  await page.locator("[data-save-result]").click();
  await form.locator('[data-segment="existing"]').click();
  await pick(page, form.locator('[aria-label="Dataset"]'), `Petal means ${name}`);
  await expect(form.locator('[aria-label="Dataset"]')).toHaveText(`Petal means ${name}`);
  await form.locator("[data-save-result-go]").click();
  await expect(form.locator("[data-result-saved]")).toContainText(`Petal means ${name} v2`);
  const datasets = (await alice("GET", `/resources?kind=dataset&scope=${project}`)).items as Envelope[];
  const saved = datasets.find(d => d.metadata.name === `Petal means ${name}`);
  expect(saved).toBeDefined();
  cleanups.push(() => alice.attempt("DELETE", `/datasets/${saved?.metadata.rid}`));
  const file = await alice.text("GET", `/datasets/${saved?.metadata.rid}/versions/1/files/aggregate.csv`);
  expect(file.split("\n")[0]).toBe("Species,avg");
  // The execution stays while the version derives from it.
  expect(await alice.status("DELETE", `/workflows/${rid}/executions/${ran.metadata.rid}`)).toBe(409);
  // The saved dataset's lineage: the version it is, saved from avg's result of the execution.
  await page.goto(`/datasets/${saved?.metadata.rid}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  await expect(page.locator('[data-graph-column="saved"]')).toBeVisible();
  await expect(page.locator('[data-graph-edge="keeps"]')).toHaveCount(1);
  await page.locator('[data-graph-level="versions"]').click();
  await expect(page.locator('[data-graph-edge="keeps"]')).toHaveCount(2);
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
  const defaults = (await alice("GET", `/projects/${(await alice("GET", "/me")).rootProject}/settings`)).defaults;
  const unit = await alice("GET", defaults.computingUnit.replace("texera://", "/"));
  const profile = await alice("GET", unit.spec.computingNodes[0].profile.split("@")[0].replace("texera://", "/"));
  const platform = await alice("GET", defaults.warehouse.replace("texera://", "/"));
  await signIn(page);
  await page.goto(`/workflows/${rid}`);

  // On the unit (made from its profile), results in the platform's warehouse unless another is picked.
  await page.locator("[data-run-options]").click();
  await expect(page.locator("[data-run-profile]")).toContainText(profile.metadata.name);
  await expect(page.getByLabel("Warehouse")).toHaveText(platform.metadata.name);
  await pick(page, page.getByLabel("Warehouse"), lab.metadata.name);
  await page.screenshot({ path: "test-results/run-target.png" });
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-latest-execution]")).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  const [ran] = (await alice("GET", `/workflows/${rid}/executions?limit=1`)).items;
  expect(ran.spec.warehouse).toBe(lab.metadata.uri);
  expect(ran.spec.computing.profile.split("@")[0]).toBe(profile.metadata.uri);

  // Its page says where it ran and what the unit had, each package as installed.
  await page.goto(`/workflows/${rid}/executions/${ran.metadata.rid}`);
  const execution = page.locator("[data-execution-view]");
  await execution.getByRole("tab", { name: "Details" }).click();
  await expect(execution.locator("[data-execution-computing] [data-ran-on]")).toContainText(`(${profile.metadata.name} v`);
  await expect(execution.locator("[data-execution-computing] [data-ran-on]")).toContainText(`results in ${lab.metadata.name}`);
  await expect(execution.locator("[data-execution-packages]")).toContainText("pandas==");
  // So does its box in lineage, on hover: the unit and the warehouse are no boxes of their own there.
  await execution.getByRole("tab", { name: "Lineage" }).click();
  const lineage = page.locator("[data-lineage]");
  await lineage.locator('[data-graph-level="versions"]').click();
  await expect(lineage.locator('[data-graph-role="run"][data-graph-root="true"]')).toHaveAttribute("data-graph-ran-on", new RegExp(`results in ${lab.metadata.name}`));
  await expect(lineage.locator('[data-graph-role="computing-unit"], [data-graph-role="warehouse"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/run-target-lineage.png" });
});

// Where a run goes is proposed as the catalog decides it for anyone's run, the agent's in a chat
// included: the workflow's unit, else its project's, else the platform's. A unit picked in the
// bar is for this page's runs and is not remembered past it.
test("the bar proposes the workflow's own unit, else the platform's, and a pick is the page's alone", async ({ page, request }) => {
  const alice = await api(request);
  const defaults = (await alice("GET", `/projects/${(await alice("GET", "/me")).rootProject}/settings`)).defaults;
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

  // Each result kept is a cylinder under its card. The chart's opens a picture, not a table of its HTML.
  await stage.locator('[data-result-chip="chart:output-0"]').click();
  await expect(stage.locator("[data-results]")).toHaveAttribute("data-result-open", "chart:output-0");
  await expect(stage.locator("[data-result-about]")).toContainText("a picture");
  await expect(stage.locator("[data-port-chart] iframe")).toBeVisible();
  await expect(stage.locator("[data-port-rows]")).toHaveCount(0);
  // What the operator drew is in the frame, whole.
  await expect(page.frameLocator("[data-port-chart] iframe").locator(".plotly-graph-div")).toHaveCount(1, { timeout: 30_000 });
  await expect(operatorCard(page, "chart").locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
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

  // The table it was drawn from is a click on its card away.
  await operatorCard(page, "avg").click();
  await expect(stage.locator("[data-results]")).toHaveAttribute("data-result-open", "avg:output-0");
  await expect(stage.locator("[data-port-rows]")).toContainText("Iris-virginica");
  await expect(operatorCard(page, "avg").locator("[data-result-shown]")).toHaveAttribute("data-result-shown", "output-0");
});

test("a run reads what an earlier run of the same work stored, and its cards say so; Run fresh makes everything again", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `reuse ${stamp}`, spec: {} });
  const dataset: Envelope = await alice("POST", "/datasets", { name: "iris", parent: project.metadata.rid, spec: { format: "csv" } });
  await alice("PUT", `/datasets/${dataset.metadata.rid}/files/iris.csv`, IRIS_CSV, "text/csv");
  await alice("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "Fisher's iris flowers" });
  const link = (from: string, to: string) => ({ linkID: `${from}-${to}`, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: "input-0" } });
  // A scan, an aggregate (costly: its rows are kept for later runs) and a filter that shows the rows.
  const spec = {
    operators: [
      { operatorID: "readings", operatorType: "scan", operatorProperties: { file: `${dataset.metadata.uri}@1/files/iris.csv` } },
      { operatorID: "means", operatorType: "aggregate", operatorProperties: { by: ["Species"], outputs: ["mean = avg(PetalLengthCm)"] } },
      { operatorID: "long", operatorType: "filter", operatorProperties: { where: "mean > 2" } },
    ],
    links: [link("readings", "means"), link("means", "long")],
  };
  const workflow: Envelope = await alice("POST", "/workflows", { name: `reuse ${stamp}`, parent: project.metadata.rid, spec });
  cleanups.push(async () => {
    await discard(alice, [workflow.metadata.rid], [dataset.metadata.rid]);
    await alice.attempt("DELETE", `/projects/${project.metadata.rid}`);
  });
  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  const latest = page.locator("[data-latest-execution]");
  const results = page.locator("[data-results]");
  const means = operatorCard(page, "means");
  const readings = operatorCard(page, "readings");
  // Runs, and waits for the run to take over the cards and to end.
  const runWith = async (button: string) => {
    const before = (await latest.count()) > 0 ? await latest.getAttribute("data-execution") : null;
    await page.locator(button).click();
    await expect(latest).not.toHaveAttribute("data-execution", before ?? "", { timeout: 60_000 });
    await expect(latest).toHaveAttribute("data-latest-execution", "completed", { timeout: 180_000 });
  };
  // The rows the filter showed, from its cylinder.
  const shown = async () => {
    await page.locator('[data-result-chip="long:output-0"]').click();
    await expect(results.locator("[data-port-rows]")).toContainText("Iris-virginica");
    await page.locator("[data-close-result]").click();
  };

  // The first run makes everything.
  await runWith("[data-run]");
  await expect(means.locator("[data-operator-reused]")).toHaveCount(0);
  await shown();

  // The second reads the aggregate's rows from the first, which its card names, and does not scan the file.
  await runWith("[data-run]");
  await expect(means.locator("[data-operator-reused]")).toContainText("Read from");
  await expect(readings.locator("[data-operator-skipped]")).toBeVisible();
  await shown();
  await page.screenshot({ path: "test-results/canvas-reused.png" });

  // Run fresh makes everything again.
  await page.locator("[data-run-options]").click();
  await runWith("[data-run-fresh]");
  await expect(means.locator("[data-operator-reused]")).toHaveCount(0);
  await expect(readings.locator("[data-operator-skipped]")).toHaveCount(0);
});

test("the data an operator reads stands above it, joined by a dashed line, until the person hides it", async ({ page, request }) => {
  const alice = await api(request);
  const iris = await withIris(alice, "resources on a canvas");
  cleanups.push(() => iris.clear());
  const file = `texera://datasets/${iris.dataset}@1/files/iris.csv`;
  const made = await alice("POST", "/workflows", {
    name: `resources ${Date.now()}`,
    parent: iris.project,
    spec: {
      operators: [
        { operatorID: "readings", operatorType: "scan", operatorProperties: { file } },
        { operatorID: "few", operatorType: "limit", operatorProperties: { n: 5 } },
      ],
      links: [{ linkID: "l", source: { operatorID: "readings", portID: "output-0" }, target: { operatorID: "few", portID: "input-0" } }],
    },
  });
  cleanups.push(() => alice.attempt("DELETE", `/resources/${made.metadata.rid}`));
  await signIn(page);
  await page.goto(`/workflows/${made.metadata.rid}`);
  const chip = page.locator('[data-canvas-resource="dataset"]');
  await expect(chip).toContainText("iris");
  await expect(chip).toHaveCount(1);
  const [above, card] = [await chip.boundingBox(), await page.locator('.react-flow__node[data-id="readings"]').boundingBox()];
  expect(above && card && above.y + above.height).toBeLessThan(card?.y ?? 0);
  await expect(page.locator(".react-flow__edge[data-id$=':line']")).toHaveCount(1);
  await page.screenshot({ path: "test-results/canvas-resources.png" });

  // A chip is read off the settings: it cannot be dragged away, and it opens what it names.
  const toggle = page.locator("[data-canvas-resources]");
  await expect(toggle).toHaveAttribute("data-canvas-resources", "shown");
  await toggle.click();
  await expect(chip).toHaveCount(0);
  await expect(page.locator(".react-flow__edge[data-id$=':line']")).toHaveCount(0);
  // The viewer's choice stays for the next canvas.
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="readings"]')).toBeVisible();
  await expect(chip).toHaveCount(0);
  await page.locator("[data-canvas-resources]").click();
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();
});

