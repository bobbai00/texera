import { expect, test } from "@playwright/test";
import { api, cleanups, inTurn, signIn, tidyUp, withIris } from "./support";

// What a chat made and what it worked from, beside it: a section per kind, each resource, its
// versions, and under a version its executions or its files, every level folding. The agent's
// calls are made here as the runtime makes them, in a turn of the chat, so no model is needed.

test.afterEach(tidyUp);

test("a chat shows what it made and worked from as a tree that folds at every level", async ({ page, request }) => {
  const alice = await api(request);
  const iris = await withIris(alice, "a chat's tree");
  const conversation = (
    await alice("POST", "/conversations", { name: `the work ${Date.now()}`, parent: iris.project, spec: {} })
  ).metadata.rid as string;
  cleanups.push(() => iris.clear(conversation));

  // In a turn of the chat, the agent makes a workflow over the person's iris, changes it, runs it.
  const agent = await inTurn(request, alice, conversation);
  const scan = {
    operatorID: "scan",
    operatorType: "CSVFileScan",
    operatorProperties: {
      fileName: `texera://datasets/${iris.dataset}@1/files/iris.csv`,
      fileEncoding: "UTF_8",
      hasHeader: true,
    },
  };
  const average = (attribute: string) => ({
    operatorID: "avg",
    operatorType: "Aggregate",
    viewResult: true,
    operatorProperties: {
      groupByKeys: ["Species"],
      aggregations: [{ aggFunction: "average", attribute, "result attribute": "avg" }],
    },
  });
  const links = [
    {
      linkID: "l1",
      source: { operatorID: "scan", portID: "output-0" },
      target: { operatorID: "avg", portID: "input-0" },
    },
  ];
  const workflow = await agent("POST", "/workflows", {
    name: "petal means",
    spec: { operators: [scan, average("PetalLengthCm")], links },
  });
  await agent("PUT", `/workflows/${workflow.metadata.rid}`, {
    spec: { operators: [scan, average("SepalWidthCm")], links },
  });
  await agent("POST", `/workflows/${workflow.metadata.rid}/run`, {});
  await agent.end();

  await signIn(page);
  await page.goto(`/conversations/${conversation}`);
  const tree = page.locator("[data-chat-tree]");
  // A section per kind, in the sidebar's order: the workflow it made, the dataset it read.
  await expect
    .poll(() =>
      tree
        .locator("[data-tree-section]")
        .evaluateAll(sections => sections.map(s => s.getAttribute("data-tree-section")))
    )
    .toEqual(["workflow", "dataset"]);

  // The workflow, made here: both versions, the newest open with its run under it.
  const made = tree.locator('[data-tree-resource="workflow"][data-made="true"]');
  await expect(made.locator("[data-open-row]").first()).toHaveText("petal means");
  const v2 = made.locator('[data-tree-version="2"][data-made="true"]');
  const v1 = made.locator('[data-tree-version="1"][data-made="true"]');
  await expect(v2.locator("[data-tree-execution]")).toHaveCount(1);
  await expect(v1).toBeVisible();
  await expect(v1.getByRole("button", { name: "Unfold v1" })).toHaveCount(0); // nothing ran it: nothing to unfold
  // Watched while it runs, the run says how it ended.
  await expect(v2.locator("[data-tree-execution]")).toHaveAttribute("data-tree-execution", "completed", {
    timeout: 120_000,
  });

  // Every level folds: the version, the workflow, the section.
  await tree.getByRole("button", { name: "Fold v2" }).click();
  await expect(v2.locator("[data-tree-execution]")).toHaveCount(0);
  await tree.getByRole("button", { name: "Unfold v2" }).click();
  await expect(v2.locator("[data-tree-execution]")).toHaveCount(1);
  await tree.getByRole("button", { name: "Fold petal means" }).click();
  await expect(made.locator("[data-tree-version]")).toHaveCount(0);
  await tree.getByRole("button", { name: "Unfold petal means" }).click();
  await expect(made.locator("[data-tree-version]")).toHaveCount(2);
  const workflows = tree.getByRole("button", { name: /^Workflows/ });
  await workflows.click();
  await expect(made).toHaveCount(0);
  await workflows.click();
  await expect(made).toHaveCount(1);

  // The dataset it worked from, dimmed and folded; unfolded, the version it read and its file.
  const used = tree.locator('[data-tree-resource="dataset"][data-made="false"]');
  await expect(used.locator("[data-open-row]").first()).toHaveText("iris");
  await expect(used.locator("[data-tree-version]")).toHaveCount(0);
  await tree.getByRole("button", { name: "Unfold iris" }).click();
  await expect(used.locator('[data-tree-version="1"][data-made="false"] [data-tree-file="iris.csv"]')).toBeVisible();
  await page.screenshot({ path: "test-results/chat-tree.png" });

  // A version opens beside the chat, at that version.
  await v1.locator("[data-open-row]").first().click();
  await expect(page.locator("[data-side-panel] [data-workflow-view]")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`panel=workflows(%2F|/)${workflow.metadata.rid}(%40|@)1`));
});
