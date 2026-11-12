import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, type Caller, cleanups, inTurn, signIn, tidyUp, withIris } from "./support";

// The chat on its own page: what the agent names is shown as cards a person can take into their
// next message. Until the chat starts work it is the page. Then it stands in a window over its
// graph, below the page's bar: sized by any of its sides, moved by its header, minimized to the
// corner, lying over everything where both do not fit. What it stands over keeps clear of it. A
// chat given the whole page gives it back when its graph has something new to show. The agent's
// messages are written here as the runtime writes them, so no model is needed.

test.afterEach(tidyUp);

const width = async (of: Locator) => Math.round((await of.boundingBox())?.width ?? 0);

/** Where something is on the page, in whole pixels. */
async function rect(of: Locator) {
  const b = await of.boundingBox();
  if (!b) throw new Error("not on the page");
  const [x, y, width, height] = [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] as const;
  return { x, y, width, height, right: x + width, bottom: y + height };
}

/** Takes hold of a handle in its middle and pulls it dx right and dy down. */
async function pull(page: Page, handle: Locator, dx: number, dy: number) {
  const held = await handle.boundingBox();
  if (!held) throw new Error("no handle");
  const [x, y] = [held.x + held.width / 2, held.y + held.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

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

test("the chat stands in a window below the page's bar, sized by any of its sides, moved by its header, minimized to the corner, and lies over what it cannot share the page with", async ({ page, request }) => {
  test.setTimeout(120_000);
  const alice = await api(request);
  const { conversation } = await chatWith(request, alice, () => [
    { type: "tool_call", toolName: "start_work", toolCallId: "c1", args: { goal: "Petal means", makes: [{ kind: "workflow", name: "petal means" }] } },
  ]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, conversation);
  const graph = page.locator("[data-resource-graph]");
  // What the graph draws on, below its bar.
  const canvas = graph.getByRole("application");
  const chat = page.locator("[data-chat-window]");
  const side = (which: string) => page.locator(`[data-chat-resize="${which}"]`);
  const grip = side("left");
  await expect(graph).toBeVisible();
  const whole = await rect(page.locator("[data-chat]"));

  // The page's bar runs the page's whole width, the chat stands below it on the right, and the
  // graph keeps clear of the chat.
  const bar = await rect(page.locator("[data-page-bar]"));
  expect(bar.width).toBe(whole.width);
  const first = await rect(chat);
  expect(first).toEqual({ x: whole.right - 12 - 480, y: bar.bottom + 12, width: 480, height: whole.bottom - bar.bottom - 24, right: whole.right - 12, bottom: whole.bottom - 12 });
  await expect.poll(async () => (await rect(canvas)).right).toBeLessThanOrEqual(first.x);

  // Its grip sizes it from the left, the size is remembered, and the keys move the grip too.
  const canvasWas = await width(canvas);
  await pull(page, grip, -150, 0);
  expect(await rect(chat)).toEqual({ ...first, x: first.x - 150, width: 630 });
  await expect.poll(() => width(canvas)).toBe(canvasWas - 150);
  await page.reload();
  await expect(graph).toBeVisible();
  expect(await width(chat)).toBe(630);
  await grip.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width(chat)).toBe(606);

  // Every other side sizes it too, and a corner sizes two at once; the sides not taken stay.
  let was = await rect(chat);
  await pull(page, side("top"), 0, 200);
  expect(await rect(chat)).toEqual({ ...was, y: was.y + 200, height: was.height - 200 });
  await pull(page, side("bottom"), 0, -150);
  expect(await rect(chat)).toEqual({ ...was, y: was.y + 200, height: was.height - 350, bottom: was.bottom - 150 });
  await pull(page, side("right"), -100, 0);
  expect(await rect(chat)).toEqual({ ...was, y: was.y + 200, height: was.height - 350, bottom: was.bottom - 150, width: was.width - 100, right: was.right - 100 });
  was = await rect(chat);
  await pull(page, side("top-left"), -40, -60);
  expect(await rect(chat)).toEqual({ ...was, x: was.x - 40, y: was.y - 60, width: was.width + 40, height: was.height + 60 });
  // It never goes over the page's bar, or off the page.
  await pull(page, side("top"), 0, -600);
  expect((await rect(chat)).y).toBe(bar.bottom + 12);
  await pull(page, side("bottom-right"), 600, 600);
  expect(await rect(chat)).toMatchObject({ right: whole.right - 12, bottom: whole.bottom - 12 });
  await page.screenshot({ path: "test-results/chat-window-sized.png" });
  // Where it was put is remembered, and a double click on a side puts it back as it first stood.
  was = await rect(chat);
  await page.reload();
  await expect(graph).toBeVisible();
  expect(await rect(chat)).toEqual(was);
  await side("top").dblclick();
  expect(await rect(chat)).toEqual(first);

  // Its header moves it, the size it is: across the page as far as it is taken, and up and down
  // as far as the page has room, which a window as tall as the page has none of.
  const hold = page.locator("[data-chat-header] [data-current-template]");
  await pull(page, hold, -100, 80);
  expect(await rect(chat)).toEqual({ ...first, x: first.x - 100, right: first.right - 100 });
  await pull(page, side("top"), 0, 300);
  await pull(page, hold, 100, -120);
  expect(await rect(chat)).toEqual({ ...first, y: first.y + 180, height: first.height - 300, bottom: first.bottom - 120 });
  await pull(page, hold, 400, -900);
  expect(await rect(chat)).toEqual({ ...first, height: first.height - 300, bottom: first.bottom - 300 });
  // Nearer the page's left it stands there, with its grip on its right, and the graph keeps
  // clear of it on that side; a click on what its header holds is still a click.
  await pull(page, hold, -900, 0);
  await expect(chat).toHaveAttribute("data-chat-side", "left");
  was = await rect(chat);
  expect(was).toMatchObject({ x: whole.x + 12, width: 480 });
  await expect.poll(async () => (await rect(canvas)).x).toBeGreaterThanOrEqual(was.right);
  await expect(side("right")).toHaveAttribute("role", "separator");
  await pull(page, side("right"), 100, 0);
  expect(await rect(chat)).toEqual({ ...was, width: 580, right: was.right + 100 });
  await page.screenshot({ path: "test-results/chat-window-moved.png" });
  // Where it was put is remembered, and a double click on a side puts it back as it first stood.
  was = await rect(chat);
  await page.reload();
  await expect(graph).toBeVisible();
  expect(await rect(chat)).toEqual(was);
  await expect(chat).toHaveAttribute("data-chat-side", "left");
  await side("bottom").dblclick();
  expect(await rect(chat)).toEqual(first);
  await expect(chat).toHaveAttribute("data-chat-side", "right");

  // Minimized, the graph has the page and the chat is a button in the corner, with what was
  // half written still in its box.
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("half a thought");
  await page.locator("[data-chat-minimize]").click();
  await expect(chat).toBeHidden();
  await expect(page.locator("[data-chat-resize]")).toHaveCount(0);
  const bubble = page.locator("[data-chat-restore]");
  const corner = await rect(bubble);
  expect(whole.right - corner.right).toBe(16);
  expect(whole.bottom - corner.bottom).toBe(16);
  await expect.poll(() => width(canvas)).toBe(whole.width);
  await page.screenshot({ path: "test-results/chat-minimized.png" });
  await bubble.click();
  await expect(chat).toBeVisible();
  await expect(bubble).toHaveCount(0);
  await expect(box).toHaveValue("half a thought");
  expect(await rect(chat)).toEqual(first);

  // In a narrow window both stay: the graph keeps clear of the chat, with room to be read.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(graph).toBeVisible();
  await expect.poll(async () => (await rect(chat)).x - (await rect(canvas)).right >= 0).toBe(true);
  await expect.poll(() => width(canvas)).toBeGreaterThanOrEqual(380);
  await page.screenshot({ path: "test-results/chat-narrow.png" });

  // Narrower than both can share, the chat lies over the graph, and minimizing it shows the graph.
  await page.setViewportSize({ width: 760, height: 700 });
  await expect(chat).toHaveAttribute("data-chat-over", "true");
  await expect(page.locator("[data-chat-resize]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/chat-over.png" });
  await page.locator("[data-chat-minimize]").click();
  await expect(graph).toBeVisible();
  await page.screenshot({ path: "test-results/chat-over-minimized.png" });
  await page.locator("[data-chat-restore]").click();
  await expect(chat).toBeVisible();
});

test("a chat is the page until it starts work, then a window beside its graph; given the whole page, it gives it back when the graph has something new to show", async ({ page, request }) => {
  test.setTimeout(180_000);
  const alice = await api(request);
  const iris = await withIris(alice, "the chat page");
  const chatOf = async (name: string) => (await alice("POST", "/conversations", { name: `${name} ${Date.now()}`, parent: iris.project, spec: {} })).metadata.rid as string;
  const conversation = await chatOf("work to come");
  const another = await chatOf("nothing yet");
  cleanups.push(() => iris.clear(conversation, [another]));
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, conversation);
  const chat = page.locator("[data-chat-window]");
  const graph = page.locator("[data-resource-graph]");
  const whole = page.locator("[data-chat-maximize]");
  /** The chat alone on its page: nothing of the project under it, and nothing to give the page to. */
  const isThePage = async () => {
    await expect(chat).toBeVisible();
    await expect.poll(async () => rect(chat)).toEqual(await rect(page.locator("[data-chat]")));
    await expect(page.locator("[data-project-overview]")).toHaveCount(0);
    await expect(page.locator("[data-chat-maximize], [data-chat-minimize], [data-chat-resize]")).toHaveCount(0);
  };
  const hasThePage = () => expect(chat).toHaveAttribute("data-chat-maximized", "true");
  const isAWindow = async () => {
    await expect(chat).not.toHaveAttribute("data-chat-maximized", "true");
    await expect(whole).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-chat-resize]")).toHaveCount(8);
  };

  // Before the chat starts work it is the page, and stays it when the catalog says there is no graph yet.
  await isThePage();
  await page.waitForResponse("**/conversations/*/graph", { timeout: 20_000 });
  await isThePage();
  await page.screenshot({ path: "test-results/chat-is-the-page.png" });

  // A long chat is read from its end. Someone who went up in it and then says something reads
  // on from its end again.
  const told = await inTurn(request, alice, conversation);
  const words = "The petals of the three species differ in length, and the difference is larger than within any one of them. ";
  for (let i = 1; i <= 12; i++) await told("POST", `/conversations/${conversation}/messages`, { turn: told.turn, role: "assistant", parts: [{ type: "text", text: `Finding ${i}. ${words.repeat(3)}` }] });
  await told.end();
  const said = page.locator("[data-message-seq]");
  await expect(said).toHaveCount(12, { timeout: 30_000 });
  await expect(said.last()).toBeInViewport();
  await said.first().scrollIntoViewIfNeeded();
  await expect(said.last()).not.toBeInViewport();
  await page.getByLabel("Message", { exact: true }).fill("a note from further up");
  await page.locator("[data-send-note]").click();
  await expect(said).toHaveCount(13, { timeout: 20_000 });
  await expect(said.last()).toBeInViewport();

  // The agent plans its work: the graph has something to show, the chat stands beside it, and
  // is still at its end.
  const agent = await inTurn(request, alice, conversation);
  await agent("POST", `/conversations/${conversation}/messages`, {
    turn: agent.turn,
    role: "assistant",
    parts: [{ type: "tool_call", toolName: "start_work", toolCallId: "c1", args: { goal: "Petal means", makes: [{ kind: "workflow", name: "petal means" }] } }],
  });
  await expect(graph).toBeVisible({ timeout: 20_000 });
  await isAWindow();
  await expect(said.last()).toBeInViewport();

  // Given the page, the chat has it while the graph says the same, and the graph has it back when it changes.
  await whole.click();
  await hasThePage();
  await expect(graph).toHaveCount(0);
  await page.waitForResponse("**/conversations/*/graph", { timeout: 20_000 });
  await hasThePage();
  await agent("POST", "/workflows", { name: "petal means", parent: iris.project, spec: { operators: [], links: [] } });
  await agent.end();
  await expect(graph).toBeVisible({ timeout: 20_000 });
  await isAWindow();
  await page.screenshot({ path: "test-results/chat-gave-way.png" });

  // A chat with a graph opens as a window beside it, whatever was done before; one without is the page.
  await whole.click();
  await hasThePage();
  await page.reload();
  await expect(graph).toBeVisible();
  await isAWindow();
  await page.goto(`/conversations/${another}`);
  await isThePage();
});
