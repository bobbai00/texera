import { expect, test } from "@playwright/test";
import { api, cleanups, discard, inTurn, signIn, tidyUp, withIris } from "./support";

// The lineage of a resource is a graph: a card per resource, an arrow per thing that happened,
// the words for it on the arrow, read left to right. Two levels: resources (the dataset, the
// workflow, its executions) and data flow (the file, the version that ran, each result). Each
// card says who made what it names.

test.afterEach(tidyUp);

test("a workflow's lineage shows what it read, how it ran and what came out, at two levels", async ({ page, request }) => {
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
  cleanups.push(async () => {
    await discard(call, [rid], [lab.dataset]);
    await call.attempt("DELETE", `/projects/${lab.project}`);
  });
  // Three executions: the two most recent stand as cards, the first folds.
  const executions: string[] = [];
  for (const n of [1, 2, 3]) {
    const execution = await call("POST", `/workflows/${rid}/run`, { waitSeconds: 180, name: `petals, run ${n} ${stamp}` });
    expect(execution.status.phase).toBe("completed");
    executions.push(execution.metadata.rid as string);
  }

  await signIn(page);
  await page.goto(`/workflows/${rid}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  const lineage = page.locator("[data-lineage]");
  const cards = (type: string) => lineage.locator(`[data-lineage-card="${type}"]`);

  // Resources: the dataset is read by the workflow, which ran as its executions. No address anywhere.
  await expect(lineage).toHaveAttribute("data-level", "resources");
  await expect(cards("resource")).toHaveCount(2);
  await expect(cards("resource").filter({ hasText: "iris" })).toContainText("Dataset · v1");
  await expect(lineage.locator('[data-lineage-card="resource"][data-root]')).toContainText(`mean petals ${stamp}`);
  await expect(lineage.locator('[data-edge="used"]')).toHaveText("read iris.csv");
  await expect(lineage.locator('[data-edge="ran"]')).toHaveText("ran");
  await expect(cards("execution")).toHaveCount(2);
  await expect(cards("execution").first()).toContainText(`petals, run 3 ${stamp}`);
  await expect(cards("execution").first()).toContainText(/Completed · \d+ results?/);
  await expect(cards("fold")).toContainText("1 earlier execution");
  await expect(lineage).not.toContainText("texera://");
  await expect(lineage).not.toContainText("iceberg://");

  // Data flow: the file, the version that ran, each execution and what it produced.
  await lineage.locator('[data-segment="flow"]').click();
  await expect(lineage).toHaveAttribute("data-level", "flow");
  await expect(cards("file")).toContainText("iris.csv");
  await expect(cards("file")).toContainText("File · v1 · iris");
  await expect(lineage.locator('[data-lineage-card="resource"][data-root]')).toContainText("Workflow · v1");
  await expect(lineage.locator('[data-edge="used"]')).toHaveText("read by scan");
  await expect(cards("result").filter({ hasText: "avg" }).first()).toContainText("Result · 3 rows");
  await expect(lineage.locator('[data-edge="produced"]').first()).toHaveText("produced");
  await page.screenshot({ path: "test-results/lineage-flow.png" });

  // The earlier executions unfold and fold again.
  await cards("fold").click();
  await expect(cards("execution")).toHaveCount(3);
  await expect(cards("fold")).toHaveCount(0);
  await lineage.locator("[data-lineage-recent]").click();
  await expect(cards("execution")).toHaveCount(2);

  // A card opens what it names beside the page.
  await cards("file").click();
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();

  // The same graph from the execution's side: the execution is the card that is marked.
  await page.goto(`/workflows/${rid}/executions/${executions[2]}`);
  await page.getByRole("tab", { name: "Lineage" }).click();
  await expect(lineage.locator('[data-lineage-card="execution"][data-root]')).toContainText(`petals, run 3 ${stamp}`);
  await expect(cards("execution")).toHaveCount(1);
  await expect(lineage.locator('[data-edge="used"]')).toHaveText("read iris.csv");
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
  const cards = (type: string) => lineage.locator(`[data-lineage-card="${type}"]`);
  // The dataset is the person's own; the workflow and its execution are the agent's, in the chat.
  const dataset = cards("resource").filter({ hasText: "iris" });
  await expect(dataset.locator('[data-made-by="person"]')).toHaveText(`by ${me}`);
  await expect(lineage.locator('[data-lineage-card="resource"][data-root] [data-made-by="agent"] [data-made-in]')).toHaveText(chatName);
  const execution = cards("execution").first();
  await expect(execution.locator('[data-made-by="agent"] [data-made-in]')).toHaveText(chatName);
  // What a card says is in its tooltip in full, with the person the agent worked for.
  await expect(execution).toHaveAttribute("title", new RegExp(`Made by Texera Agent for ${me}, in the chat ${chatName}`));
  await page.screenshot({ path: "test-results/lineage-made-by.png" });

  // The chat's name opens the chat beside, and the chat says who started it.
  await execution.locator("[data-made-in]").click();
  const chat = page.locator("[data-side-panel] [data-conversation-view]");
  await expect(chat).toBeVisible();
  await expect(chat).toContainText(`started by ${me}`);
  // A card itself still opens what it names, once the panel is out of its way.
  await page.locator("[data-side-panel]").getByRole("button", { name: "Close panel" }).click();
  await dataset.click();
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();

  // The chat's own page says who started it too.
  await page.goto(`/conversations/${conversation}`);
  await expect(page.locator("[data-chat-header]")).toContainText(`started by ${me}`);
});
