import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, type Caller, cleanups, inTurn, signIn, tidyUp, withIris } from "./support";

// The chat on its own page: what the agent names is shown as cards a person can take into their
// next message, and the chat shares the page with what stands beside it, sized by its grip,
// minimized to the corner, lying over it where both do not fit. The agent's messages are written
// here as the runtime writes them, so no model is needed.

test.afterEach(tidyUp);

const width = async (of: Locator) => Math.round((await of.boundingBox())?.width ?? 0);

/** A chat in a project of its own, with what an agent wrote in a turn of it. */
async function chatWith(request: Parameters<typeof api>[0], alice: Caller, parts: (made: { dataset: string; workflow: string }) => unknown[]) {
  const iris = await withIris(alice, "the chat page");
  const conversation = (await alice("POST", "/conversations", { name: `the chat page ${Date.now()}`, parent: iris.project, spec: {} })).metadata.rid as string;
  const flow = await alice("POST", "/workflows", { name: "a flow to pick", parent: iris.project, spec: { operators: [], links: [] } });
  cleanups.push(() => iris.clear(conversation, [flow.metadata.rid as string]));
  const made = { dataset: `texera://datasets/${iris.dataset}@1`, workflow: flow.metadata.uri as string };
  const agent = await inTurn(request, alice, conversation);
  await agent("POST", `/conversations/${conversation}/messages`, { turn: agent.turn, role: "assistant", parts: parts(made) });
  await agent.end();
  return { conversation, ...made };
}

const open = async (page: Page, conversation: string) => {
  await signIn(page);
  await page.goto(`/conversations/${conversation}`);
};

test("what the agent names is shown as cards, and a card goes with the next message", async ({ page, request }) => {
  test.setTimeout(120_000);
  const alice = await api(request);
  const { conversation, dataset, workflow } = await chatWith(request, alice, made => [
    {
      type: "text",
      text: `Two things fit:\n\n- ${made.dataset}\n- ${made.workflow}\n\nThe first, \`${made.dataset}\`, is smaller.`,
    },
  ]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, conversation);

  // Each URI alone on a line is its card; the one in the sentence reads as the name; no URI shows.
  const reply = page.locator('[data-message-role="assistant"]');
  const cards = reply.locator("[data-part=resources] [data-resource-card]");
  await expect(cards).toHaveCount(2);
  const [theData, theFlow] = [cards.filter({ hasText: "iris" }), cards.filter({ hasText: "a flow to pick" })];
  await expect(theData).toHaveAttribute("data-resource-card", "dataset");
  await expect(theFlow).toHaveAttribute("data-resource-card", "workflow");
  await expect(reply.locator("p [data-uri-chip=dataset]")).toContainText("iris");
  await expect(reply).not.toContainText("texera://");

  // A card picked is marked, and goes in the box; taken out either way, it is gone from both.
  const inBox = page.locator("[data-composer-pick]");
  await theData.locator("[data-card-pick]").click();
  await expect(theData).toHaveAttribute("data-card-picked", "true");
  await expect(theData.locator("[data-card-pick]")).toHaveAttribute("aria-pressed", "true");
  await expect(inBox).toHaveCount(1);
  await expect(inBox).toContainText("iris");
  await theFlow.locator("[data-card-pick]").click();
  await expect(inBox).toHaveCount(2);
  await page.screenshot({ path: "test-results/chat-cards-picked.png" });
  await page.locator(`[data-composer-pick="${workflow}"] button[aria-label="Take it out of this message"]`).click();
  await expect(inBox).toHaveCount(1);
  await expect(theFlow).not.toHaveAttribute("data-card-picked", "true");
  await theFlow.locator("[data-card-pick]").click();
  await theFlow.locator("[data-card-pick]").click();
  await expect(inBox).toHaveCount(1);

  // What goes with a message goes with it even with no words, and the box is empty after.
  await page.locator("[data-send-note]").click();
  await expect(inBox).toHaveCount(0);
  await expect(theData).not.toHaveAttribute("data-card-picked", "true");
  const mine = page.locator('[data-message-role="user"]');
  await expect(mine.locator(`[data-resource-card=dataset]`)).toHaveCount(1);
  // A person's own message is not offered back to them.
  await expect(mine.locator("[data-card-pick]")).toHaveCount(0);

  const history = (await alice("GET", `/conversations/${conversation}/messages?limit=50`)).items as { role: string; parts: Record<string, unknown>[] }[];
  const note = history.findLast(m => m.role === "user");
  expect(note?.parts).toEqual([expect.objectContaining({ type: "resource", resource: dataset })]);
  expect(note?.parts[0]).not.toHaveProperty("text");
});

test("the chat beside its graph is sized by its grip, minimized to the corner, and lies over what it cannot share the page with", async ({ page, request }) => {
  test.setTimeout(120_000);
  const alice = await api(request);
  const { conversation } = await chatWith(request, alice, () => [
    { type: "tool_call", toolName: "start_work", toolCallId: "c1", args: { goal: "Petal means", makes: [{ kind: "workflow", name: "petal means" }] } },
  ]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, conversation);
  const graph = page.locator("[data-resource-graph]");
  const chat = page.locator("[data-chat-window]");
  const grip = page.locator("[data-chat-resize]");
  await expect(graph).toBeVisible();
  expect(await width(chat)).toBe(480);

  // The grip sizes it, the size is remembered, a double click puts it back.
  const held = await grip.boundingBox();
  if (!held) throw new Error("no grip");
  const [x, y] = [held.x + held.width / 2, held.y + held.height / 2];
  const graphWas = await width(graph);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y, { steps: 6 });
  await page.mouse.up();
  expect(await width(chat)).toBe(630);
  expect(await width(graph)).toBe(graphWas - 150);
  await page.reload();
  await expect(graph).toBeVisible();
  expect(await width(chat)).toBe(630);
  await grip.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width(chat)).toBe(606);
  await grip.dblclick();
  expect(await width(chat)).toBe(480);

  // Minimized, the graph has the page and the chat is a button in the corner, with what was
  // half written still in its box.
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("half a thought");
  await page.locator("[data-chat-minimize]").click();
  await expect(chat).toBeHidden();
  const bubble = page.locator("[data-chat-restore]");
  const [root, corner] = [await page.locator("[data-chat]").boundingBox(), await bubble.boundingBox()];
  expect(root && corner && Math.round(root.x + root.width - (corner.x + corner.width))).toBe(16);
  expect(root && corner && Math.round(root.y + root.height - (corner.y + corner.height))).toBe(16);
  await expect.poll(() => width(graph)).toBe(Math.round(root?.width ?? 0));
  await page.screenshot({ path: "test-results/chat-minimized.png" });
  await bubble.click();
  await expect(chat).toBeVisible();
  await expect(bubble).toHaveCount(0);
  await expect(box).toHaveValue("half a thought");
  expect(await width(chat)).toBe(480);

  // In a narrow window both stay, side by side.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(graph).toBeVisible();
  await expect.poll(async () => {
    const [g, c] = [await graph.boundingBox(), await chat.boundingBox()];
    return g && c ? c.x - (g.x + g.width) >= 0 : false;
  }).toBe(true);
  expect(await width(graph)).toBeGreaterThanOrEqual(380);
  await page.screenshot({ path: "test-results/chat-narrow.png" });

  // Narrower than both can share, the chat lies over the graph, and minimizing it shows the graph.
  await page.setViewportSize({ width: 760, height: 700 });
  await expect(chat).toHaveAttribute("data-chat-over", "true");
  await expect(grip).toHaveCount(0);
  await page.screenshot({ path: "test-results/chat-over.png" });
  await page.locator("[data-chat-minimize]").click();
  await expect(graph).toBeVisible();
  await page.screenshot({ path: "test-results/chat-over-minimized.png" });
  await page.locator("[data-chat-restore]").click();
  await expect(chat).toBeVisible();
});
