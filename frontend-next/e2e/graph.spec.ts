import { expect, type Locator, test } from "@playwright/test";
import { api, cleanups, inTurn, signIn, tidyUp, withIris } from "./support";

// Once a chat starts work, what it reads, makes and runs takes the left of the chat page as a
// graph: round nodes by kind with their names, labelled arrows in columns of dependency, what
// its plan has not made yet dashed. A node stays where it was put when others arrive, a click
// says what it is, and the same things are a list a click away. The agent's calls are made
// here as the runtime makes them, in a turn of the chat, so no model is needed.

test.afterEach(tidyUp);

/** Where each node of the graph is on screen, by what it stands for. */
async function positions(graph: Locator) {
  const out = new Map<string, { x: number; y: number }>();
  for (const node of await graph.locator("[data-graph-node]").all()) {
    const box = await node.boundingBox();
    if (box) out.set((await node.getAttribute("data-graph-node")) as string, { x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

test("a chat that started work shows what it read, made and ran as a graph, and nothing moves when more arrives", async ({ page, request }) => {
  test.setTimeout(300_000);
  const alice = await api(request);
  const iris = await withIris(alice, "a chat's graph");
  const conversation = (await alice("POST", "/conversations", { name: `the graph ${Date.now()}`, parent: iris.project, spec: {} })).metadata
    .rid as string;
  cleanups.push(() => iris.clear(conversation));
  const file = `texera://datasets/${iris.dataset}@1/files/iris.csv`;
  const link = (from: string, to: string) => ({ linkID: `${from}-${to}`, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: "input-0" } });
  const means = (where: string) => ({
    operators: [
      { operatorID: "readings", operatorType: "scan", operatorProperties: { file } },
      { operatorID: "means", operatorType: "aggregate", operatorProperties: { by: ["Species"], outputs: ["mean = avg(PetalLengthCm)"] } },
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
      { type: "tool_call", toolName: "search_pubmed", toolCallId: "c0", server: biomcp, args: { query: "iris petal length" } },
      {
        type: "tool_call",
        toolName: "start_work",
        toolCallId: "c1",
        args: { goal: "Petal means", makes: [{ kind: "workflow", name: "petal means" }, { kind: "dataset", name: "Long petals" }] },
      },
    ],
  });
  const first = await agent("POST", "/workflows", { name: "petal means", spec: means("mean > 2") });
  await agent("POST", `/workflows/${first.metadata.rid}/run`, { waitSeconds: 120 });
  await agent.end();

  await signIn(page);
  await page.goto(`/conversations/${conversation}`);
  const graph = page.locator("[data-resource-graph]");
  const workflows = graph.locator('[data-graph-role="workflow"]');
  await expect(workflows).toHaveCount(1);
  await expect(workflows.first()).toContainText("petal means");
  await expect(graph.locator('[data-graph-role="data"]').filter({ hasText: "iris" })).toHaveCount(1);
  await expect(graph.locator('[data-graph-role="unit"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-planned="true"]')).toContainText("Long petals");
  await expect(graph.locator('[data-graph-edge="reads"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-edge="runsOn"]')).toHaveCount(1);
  await expect(graph.locator('[data-graph-edge="makes"]')).not.toHaveCount(0);
  await expect(graph.locator("[data-graph-band='0']")).toHaveText("Used");
  // Above it, the outside source the agent consulted; a click lists what it asked.
  const source = graph.locator('[data-graph-sources] [data-graph-source="biomcp"]');
  await expect(source).toContainText("1 call");
  await source.click();
  await expect(graph.locator("[data-graph-calls] li")).toHaveCount(1);
  await expect(graph.locator("[data-graph-calls] li")).toContainText("iris petal length");
  await page.screenshot({ path: "test-results/resource-graph.png" });
  const before = await positions(graph);

  // A second workflow arrives: the page follows it, and the nodes already there stay where they were.
  agent = await inTurn(request, alice, conversation);
  const second = await agent("POST", "/workflows", { name: "short petals", spec: means("mean < 2") });
  await agent("POST", `/workflows/${second.metadata.rid}/run`, { waitSeconds: 120 });
  await agent.end();
  await expect(workflows).toHaveCount(2, { timeout: 30_000 });
  const after = await positions(graph);
  for (const [id, place] of before) expect(after.get(id), id).toEqual(place);

  // A click says what a node is, and its runs.
  await workflows.filter({ hasText: "petal means" }).click();
  const detail = page.locator("[data-graph-detail]");
  await expect(detail).toContainText("made in this chat");
  await expect(detail.locator("[data-graph-runs] li")).toHaveCount(1);
  // The same things are a list a click away.
  await page.locator('[data-resource-view="list"]').click();
  await expect(page.locator("[data-chat-tree]")).toBeVisible();
});
