import { expect, test } from "@playwright/test";
import { api, cleanups, discard, signIn, tidyUp, withIris } from "./support";

// The lineage of a resource is a graph: a card per resource, an arrow per thing that happened,
// the words for it on the arrow, read left to right. Two levels: resources (the dataset, the
// workflow, its executions) and data flow (the file, the version that ran, each result).

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
