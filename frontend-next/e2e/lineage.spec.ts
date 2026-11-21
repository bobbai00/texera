import { expect, type Locator, test } from "@playwright/test";
import { api, cleanups, discard, inTurn, signIn, tidyUp, withIris } from "./support";

// A resource's Lineage tab draws the graph a chat draws beside it, around the resource, which is
// marked: zoomed out a box for each resource, zoomed in a row for each version, each execution
// off the version it ran with what it kept. Each version and execution says who made it. A box
// opens what it names beside the page.

test.afterEach(tidyUp);

/** Zooms the graph to a level, all of it in view. */
async function toLevel(graph: Locator, level: "resources" | "versions") {
  await graph.locator(`[data-graph-level="${level}"]`).click();
  await expect(graph.locator("[data-graph-zoom]")).toHaveAttribute("data-graph-zoom", level);
  await graph.locator("[data-graph-fit]").click();
}

test("a workflow's lineage shows what it read, each execution off the version it ran and what came out, at two levels", async ({ page, request }) => {
  test.setTimeout(240_000);
  const call = await api(request);
  const stamp = Date.now();
  const lab = await withIris(call, "lineage lab");
  const workflow = await call("POST", "/workflows", {
    name: `mean petals ${stamp}`,
    parent: lab.project,
    spec: {
      operators: [
        { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${lab.dataset}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
        { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
      ],
      links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
    },
  });
  const rid = workflow.metadata.rid as string;
  const uri = workflow.metadata.uri as string;
  cleanups.push(async () => {
    await discard(call, [rid], [lab.dataset]);
    await call.attempt("DELETE", `/projects/${lab.project}`);
  });
  const executions: string[] = [];
  for (const n of [1, 2]) {
    const execution = await call("POST", `/workflows/${rid}/run`, { waitSeconds: 180, name: `petals, run ${n} ${stamp}` });
    expect(execution.status.phase).toBe("completed");
    executions.push(execution.metadata.uri as string);
  }

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  const lineage = page.locator("[data-lineage]");

  // Resources: the iris read by the workflow, which is marked, and what its newest execution kept.
  await expect(lineage.locator("[data-graph-zoom]")).toHaveAttribute("data-graph-zoom", "resources");
  await expect(lineage.locator('[data-graph-role="data"]').filter({ hasText: "iris" })).toContainText("Dataset · v1");
  await expect(lineage.locator(`[data-graph-node="${uri}"]`)).toHaveAttribute("data-graph-root", "true");
  await expect(lineage.locator('[data-graph-edge="reads"]')).toHaveCount(1);
  await expect(lineage.locator('[data-graph-edge="reads"]')).not.toHaveAttribute("data-graph-dashed", "true");
  await expect(lineage.locator('[data-graph-role="result"]')).toHaveCount(1);
  await expect(lineage.locator('[data-graph-role="run"]')).toHaveCount(0);
  await expect(lineage).not.toContainText("texera://");
  await expect(lineage).not.toContainText("iceberg://");

  // Versions: the version on screen marked, both executions off it, each with what it kept.
  await toLevel(lineage, "versions");
  await expect(lineage.locator(`[data-graph-row="${uri}@1"]`)).toHaveAttribute("data-graph-on-screen", "true");
  const runs = lineage.locator(`[data-graph-role="run"][data-graph-of="${uri}"]`);
  await expect(runs).toHaveCount(2);
  await expect(runs.first()).toHaveAttribute("data-graph-ran", "1");
  await expect(lineage.locator('[data-graph-edge="runs"]')).toHaveCount(2);
  await expect(lineage.locator('[data-graph-role="result"]')).toHaveCount(2);
  await expect(lineage.locator('[data-graph-role="result"]').first()).toContainText("3 rows");
  await page.screenshot({ path: "test-results/lineage-versions.png" });

  // A box opens what it names beside the page.
  await lineage.locator('[data-graph-role="data"]').filter({ hasText: "iris" }).click({ position: { x: 14, y: 12 } });
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();

  // The same graph from the execution's side: the execution is the box that is marked.
  await page.goto(executions[1]?.replace("texera://", "/") ?? "");
  await page.getByRole("tab", { name: "Lineage" }).click();
  await toLevel(lineage, "versions");
  await expect(lineage.locator('[data-graph-role="run"]')).toHaveCount(1);
  await expect(lineage.locator('[data-graph-role="run"]')).toHaveAttribute("data-graph-root", "true");
  await expect(lineage.locator('[data-graph-edge="reads"]')).toHaveCount(1);
});

// Who made each thing is said on its card: a person, or a chat (the agent in it, for a person),
// the chat a link of its own; the chat says who started it.
test("lineage says who made each thing: a person, or the agent in a chat someone started", async ({ page, request }) => {
  test.setTimeout(240_000);
  const call = await api(request);
  const me = (await call("GET", "/me")).principal.displayName as string;
  const lab = await withIris(call, "who made it");
  const chatName = `the work ${Date.now()}`;
  const conversation = (await call("POST", "/conversations", { name: chatName, parent: lab.project, spec: {} })).metadata.rid as string;
  cleanups.push(() => lab.clear(conversation));
  // In a turn of the chat, the agent makes a workflow over the iris the person put there, and runs it.
  const agent = await inTurn(request, call, conversation);
  const workflow = await agent("POST", "/workflows", {
    name: "petal means",
    spec: {
      operators: [
        { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${lab.dataset}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
        { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
      ],
      links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
    },
  });
  const rid = workflow.metadata.rid as string;
  expect((await agent("POST", `/workflows/${rid}/run`, { waitSeconds: 180 })).status.phase).toBe("completed");
  await agent.end();

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  const lineage = page.locator("[data-lineage]");
  await toLevel(lineage, "versions");
  // The dataset is the person's own; the workflow's version and its execution are the agent's, in the chat.
  const dataset = lineage.locator('[data-graph-role="data"]').filter({ hasText: "iris" });
  await expect(dataset.locator('[data-made-by="person"]')).toHaveText(`by ${me}`);
  await expect(lineage.locator('[data-graph-root="true"] [data-graph-version] [data-made-by="agent"] [data-made-in]')).toHaveText(chatName);
  const execution = lineage.locator('[data-graph-role="run"]').first();
  await expect(execution.locator('[data-made-by="agent"] [data-made-in]')).toHaveText(chatName);
  // Who made it is said in full on hover, with the person the agent worked for.
  await expect(execution.locator('[data-made-by="agent"]')).toHaveAttribute("title", new RegExp(`Made by Texera Agent for ${me}, in the chat ${chatName}`));
  await page.screenshot({ path: "test-results/lineage-made-by.png" });

  // The chat's name opens the chat beside, and the chat says who started it.
  await execution.locator("[data-made-in]").click();
  const chat = page.locator("[data-side-panel] [data-conversation-view]");
  await expect(chat).toBeVisible();
  await expect(chat).toContainText(`started by ${me}`);
  // A box itself still opens what it names, once the panel is out of its way.
  await page.locator("[data-side-panel]").getByRole("button", { name: "Close panel" }).click();
  await dataset.click({ position: { x: 14, y: 12 } });
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();

  // The chat's own page says who started it too.
  await page.goto(`/conversations/${conversation}`);
  await expect(page.locator("[data-chat-header]")).toContainText(`started by ${me}`);
});

test("a person a workflow is shared with sees its lineage steadily, what is not shared with them named so", async ({ page, request }) => {
  test.setTimeout(240_000);
  const alice = await api(request);
  const bob = await api(request, "bob");
  const lab = await withIris(alice, "shared lineage");
  const workflow = await alice("POST", "/workflows", {
    name: `petals for bob ${Date.now()}`,
    parent: lab.project,
    spec: {
      operators: [
        { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${lab.dataset}@1/files/iris.csv`, fileEncoding: "UTF_8", hasHeader: true } },
        { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["Species"], aggregations: [{ aggFunction: "average", attribute: "PetalLengthCm", "result attribute": "avg" }] } },
      ],
      links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
    },
  });
  const rid = workflow.metadata.rid as string;
  cleanups.push(async () => {
    await discard(alice, [rid], [lab.dataset]);
    await alice.attempt("DELETE", `/projects/${lab.project}`);
  });
  expect((await alice("POST", `/workflows/${rid}/run`, { waitSeconds: 180 })).status.phase).toBe("completed");
  // The workflow is shared with Bob; the dataset it reads is not.
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  await alice("PUT", `/resources/${rid}/grants/${bobPid}`, { relation: "viewer" });

  await signIn(page, "bob");
  await page.goto(`/workflows/${rid}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  const lineage = page.locator("[data-lineage]");
  await toLevel(lineage, "versions");
  await expect(lineage.locator('[data-graph-role="run"]')).toHaveCount(1);
  await expect(lineage.locator('[data-graph-readable="false"]')).toContainText("Not shared with you");
  await expect(lineage.locator('[data-graph-readable="false"]')).toContainText("Dataset");
  // Once drawn, the graph stays: it is not taken off screen and asked for again and again.
  const resolved = { n: 0 };
  page.on("request", r => {
    if (r.url().includes("/catalog/v1/resources/resolve")) resolved.n++;
  });
  await lineage.evaluate(el => {
    const w = window as unknown as { lineageGone: number };
    w.lineageGone = 0;
    new MutationObserver(() => {
      if (!el.isConnected) w.lineageGone++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => (window as unknown as { lineageGone: number }).lineageGone)).toBe(0);
  expect(resolved.n).toBeLessThan(5);
});
