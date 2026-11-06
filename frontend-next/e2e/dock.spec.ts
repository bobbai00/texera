import { expect, type Page, test } from "@playwright/test";
import { aPageOfEveryKind, api, type Caller, cleanups, discard, type Envelope, type PageOf, pick, signIn, tidyUp, workAtHome, workIn } from "./support";

// The agent beside a page: on the page of any resource a chat opens over it, and what is asked
// there reaches the agent with a line that says which resource the person is looking at. The
// chat is an ordinary one; the app remembers the one last used beside each page.

test.afterEach(tidyUp);

/** The dock's box, once the dock is open. */
const dock = (page: Page) => page.locator("[data-chat-dock]");

async function openDock(page: Page) {
  await page.locator("[data-chat-dock-button]").click();
  await expect(dock(page)).toBeVisible();
}

/**
 * Answers the next turn in place of the agent runtime, in the runtime's order: the catalog
 * has the turn before the stream says it is over. Hands back what the page sent: the run's
 * input, with the context the dock adds, and the conversation it was sent to.
 */
async function answerAs(page: Page, as: Caller, answer: string) {
  let recorded: () => void = () => undefined;
  const sent: { input?: { context: { description: string; value: string }[]; messages: { content: string }[] }; conversation?: string; recorded: Promise<void> } = {
    recorded: new Promise<void>(resolve => {
      recorded = resolve;
    }),
  };
  await page.route("**/agents/conversations/*/ag-ui", async route => {
    sent.input = route.request().postDataJSON();
    const rid = /conversations\/([0-9a-f-]{36})\//.exec(route.request().url())?.[1] as string;
    sent.conversation = rid;
    const events = [
      { type: "RUN_STARTED", threadId: rid, runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: answer },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: rid, runId: "r" },
    ];
    const turn = await as("POST", `/conversations/${rid}/turns`, {});
    await as("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "user", parts: [{ type: "text", text: sent.input?.messages.at(-1)?.content }] });
    await as("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "assistant", template: turn.template, parts: [{ type: "text", text: answer }] });
    await as("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") });
    recorded();
  });
  return sent;
}

/**
 * Follows the open dock from now on. Hands back which chats it has shown since, in order
 * ("new" while there is none yet), and what each chat looked like as it changed: whether its
 * box was busy or free to write in, and whether anything the person said was in it.
 */
async function watchDock(page: Page) {
  type Seen = { chats: (string | null)[]; looked: string[] };
  await dock(page).evaluate(box => {
    const seen: Seen = { chats: [], looked: [] };
    (window as unknown as { dockSeen: Seen }).dockSeen = seen;
    new MutationObserver(records => {
      for (const record of records) if (record.attributeName === "data-chat-dock") seen.chats.push(record.oldValue);
      const chat = box.querySelector("[data-chat]");
      if (!chat) return;
      const box_ = chat.querySelector("button[aria-label='Stop generating']") ? "busy" : chat.querySelector("button[aria-label='Send message']") ? "free" : "no box";
      const look = `${box_}, ${chat.querySelector('[data-message-role="user"]') ? "said" : "nothing said"}`;
      if (seen.looked.at(-1) !== look) seen.looked.push(look);
    }).observe(box, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
  });
  return async () => {
    const seen = await page.evaluate(() => (window as unknown as { dockSeen: Seen }).dockSeen);
    return { chats: [...seen.chats, await dock(page).getAttribute("data-chat-dock")], looked: seen.looked };
  };
}

async function askInDock(page: Page, text: string) {
  await dock(page).getByLabel("Message", { exact: true }).fill(text);
  await dock(page).getByLabel("Send message").click();
}

/** Forgets the chats the docks of this scenario remembered, and removes them. */
function forgetDocks(as: Caller, conversations: () => string[]) {
  cleanups.push(async () => {
    for (const rid of conversations()) await as.attempt("DELETE", `/resources/${rid}`);
    const { dock: _, ...preferences } = (await as("GET", "/me")).preferences as Record<string, unknown>;
    await as("PUT", "/me/preferences", preferences);
  });
}

test("the agent can be asked from the page of every kind of resource, and is told which page", async ({ page, request }) => {
  test.setTimeout(240_000);
  const as = await api(request);
  const { pages } = await aPageOfEveryKind(as);
  const home = (await as("GET", "/me")).homeProject as string;
  const chats: string[] = [];
  forgetDocks(as, () => chats);
  // Every kind the catalog has a page for, but the chat itself and the settings.
  expect(pages.map(p => p.kind).sort()).toEqual(
    ["agent-template", "computing-unit", "credential", "dataset", "execution", "mcp-server", "model", "model-endpoint", "operator", "profile", "project", "skill", "warehouse", "workflow"].sort()
  );

  await signIn(page);
  for (const [i, at] of pages.entries()) {
    await test.step(`${at.kind}: ${at.name}`, async () => {
      await page.goto(at.path);
      await openDock(page);
      await expect(dock(page).locator("[data-dock-about]")).toContainText(at.name);
      const answer = `Answer ${i} about ${at.kind}.`;
      const sent = await answerAs(page, as, answer);
      const shown = await watchDock(page);
      await askInDock(page, "What is this?");
      await expect(dock(page).getByText(answer).first()).toBeVisible();
      await sent.recorded;
      await page.unroute("**/agents/conversations/*/ag-ui");
      // Known from here on, so it is removed whatever the rest finds.
      expect(sent.conversation).toBeDefined();
      chats.push(sent.conversation as string);

      // The dock goes to the chat it made and stays on it while the app saves which chat that
      // is. That chat is busy with the question from the moment it shows: it is never an empty
      // chat with a box to write in, which is what the end of an answer looks like.
      const beside = at.path.split("/").at(-1) as string;
      await expect.poll(async () => ((await as("GET", "/me")).preferences.dock ?? {})[beside]).toBe(sent.conversation);
      const seen = await shown();
      expect(seen.chats).toEqual(["new", sent.conversation]);
      expect(seen.looked, seen.looked.join(" > ")).not.toContain("free, nothing said");

      // The agent is told what the person is looking at: the resource by name and URI.
      expect(sent.input?.context[0]?.description).toBe("The person is looking at");
      expect(sent.input?.context[0]?.value).toContain(`"${at.name}"`);
      expect(sent.input?.context[0]?.value).toContain(`(${at.uri})`);
      // The chat is an ordinary one, in the project the person works in, as anything they make.
      const chat = await as("GET", `/conversations/${sent.conversation}`);
      expect(chat.metadata.project).toBe(home);
      expect(chat.spec).toEqual({});
    });
  }
  await page.screenshot({ path: "test-results/dock.png", fullPage: true });
});

test("with every project in view, the chat beside a page proposes the page's own project, and the person may choose another", async ({ page, request }) => {
  const as = await api(request);
  const stamp = Date.now();
  const lab: Envelope = await as("POST", "/projects", { name: `dock lab ${stamp}`, spec: {} });
  const workflow: Envelope = await as("POST", "/workflows", { name: `dock where ${stamp}`, parent: lab.metadata.rid, spec: { operators: [], links: [] } });
  const home = (await as("GET", "/me")).homeProject as string;
  const chats: string[] = [];
  cleanups.push(async () => {
    await workAtHome(as);
    await discard(as, [workflow.metadata.rid]);
    await as.attempt("DELETE", `/projects/${lab.metadata.rid}`);
  });
  forgetDocks(as, () => chats);

  await signIn(page);
  await workIn(page, "All projects");
  // The pick is kept by the catalog: once it has it, another page of the app starts from it.
  await expect.poll(async () => (await as("GET", "/me")).preferences.project).toBe("all");
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await openDock(page);
  // No one project is worked in, so the box says where the chat will go: where the page's
  // workflow is, since the person may add there.
  const box = dock(page).locator("[data-new-chat]");
  await expect(box).toHaveAttribute("data-new-chat-in", lab.metadata.rid);
  await expect(dock(page).getByLabel("Project for this chat")).toHaveText(`dock lab ${stamp}`);
  // Their own choice replaces it.
  await pick(page, dock(page).getByLabel("Project for this chat"), "Personal");
  await expect(box).toHaveAttribute("data-new-chat-in", home);
  const sent = await answerAs(page, as, "It is empty.");
  await askInDock(page, "What is in this workflow?");
  await expect(dock(page).getByText("It is empty.").first()).toBeVisible();
  await sent.recorded;
  chats.push(sent.conversation as string);
  expect((await as("GET", `/conversations/${sent.conversation}`)).metadata.project).toBe(home);
});

test("a page's dock continues the chat last used there, and starts over when asked", async ({ page, request }) => {
  const as = await api(request);
  const workflow: Envelope = await as("POST", "/workflows", { name: `dock memory ${Date.now()}`, spec: { operators: [], links: [] } });
  const other: Envelope = await as("POST", "/datasets", { name: `dock memory ${Date.now()}`, spec: { format: "csv" } });
  cleanups.push(() => discard(as, [workflow.metadata.rid], [other.metadata.rid]));
  const chats: string[] = [];
  forgetDocks(as, () => chats);

  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  // Nothing in the way of the page until it is asked for.
  await expect(dock(page)).toHaveCount(0);
  await openDock(page);
  await expect(dock(page)).toHaveAttribute("data-chat-dock", "new");
  const sent = await answerAs(page, as, "It is empty.");
  await askInDock(page, "What is in this workflow?");
  await expect(dock(page).getByText("It is empty.").first()).toBeVisible();
  await sent.recorded;
  const first = sent.conversation as string;
  chats.push(first);
  await expect(dock(page)).toHaveAttribute("data-chat-dock", first);

  // Another page has a dock of its own; back on the first, the chat is where it was left.
  await page.goto(`/datasets/${other.metadata.rid}`);
  await openDock(page);
  await expect(dock(page)).toHaveAttribute("data-chat-dock", "new");
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await openDock(page);
  await expect(dock(page)).toHaveAttribute("data-chat-dock", first);
  await expect(dock(page).getByText("What is in this workflow?")).toBeVisible();

  // It is a chat like any other: it opens as a page.
  await dock(page).locator("[data-dock-open-page]").click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${first}`));
  // A chat's own page has no dock: it is the chat.
  await expect(page.locator("[data-chat-dock-button]")).toHaveCount(0);

  // Starting over forgets it; the chat itself stays.
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await openDock(page);
  await dock(page).locator("[data-dock-new]").click();
  await expect(dock(page)).toHaveAttribute("data-chat-dock", "new");
  expect((await as("GET", `/conversations/${first}`)).metadata.rid).toBe(first);
  await dock(page).locator("[data-dock-close]").click();
  await expect(dock(page)).toHaveCount(0);
});

test("on a workflow's canvas the agent is told which operator is selected", async ({ page, request }) => {
  const as = await api(request);
  const spec = { operators: [{ operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 5 } }], links: [] };
  const workflow: Envelope = await as("POST", "/workflows", { name: `dock canvas ${Date.now()}`, spec });
  cleanups.push(() => discard(as, [workflow.metadata.rid]));
  const chats: string[] = [];
  forgetDocks(as, () => chats);

  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await page.locator('.react-flow__node[data-id="limit"]').click();
  await openDock(page);
  const sent = await answerAs(page, as, "It keeps five rows.");
  await askInDock(page, "What does this one do?");
  await expect(dock(page).getByText("It keeps five rows.").first()).toBeVisible();
  await sent.recorded;
  chats.push(sent.conversation as string);
  expect(sent.input?.context).toEqual([
    { description: "The person is looking at", value: `Workflow "${workflow.metadata.name}" (${workflow.metadata.uri})` },
    { description: "On that page", value: "the operator limit is selected" },
  ]);
});

// Open, the chat is a window over the page that blocks nothing else on it: its header moves it,
// its top left corner sizes it, the page stays in use around it, and it opens again where it
// was left; a double click on its header puts it back.
test("the chat beside a page is a window that moves, sizes and stays out of the page's way", async ({ page, request }) => {
  const as = await api(request);
  const spec = { operators: [{ operatorID: "limit", operatorType: "Limit", operatorProperties: { limit: 5 } }], links: [] };
  const workflow: Envelope = await as("POST", "/workflows", { name: `dock window ${Date.now()}`, spec });
  cleanups.push(() => discard(as, [workflow.metadata.rid]));
  await signIn(page);
  await page.goto(`/workflows/${workflow.metadata.rid}`);
  await openDock(page);
  const box = async () => (await dock(page).boundingBox()) as { x: number; y: number; width: number; height: number };
  const start = await box();

  // Moved by its header.
  const header = dock(page).locator("[data-dock-header]");
  const at = (await header.boundingBox()) as { x: number; y: number };
  await page.mouse.move(at.x + 60, at.y + 20);
  await page.mouse.down();
  await page.mouse.move(at.x - 240, at.y - 10, { steps: 6 });
  await page.mouse.up();
  const shifted = await box();
  expect(Math.round(shifted.x - start.x)).toBe(-300);
  expect(Math.round(shifted.y - start.y)).toBe(-30);
  expect(shifted.width).toBe(start.width);

  // Sized by its top left corner: its bottom right corner stays put.
  const grip = (await dock(page).locator("[data-dock-grip]").boundingBox()) as { x: number; y: number };
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x - 96, grip.y + 104, { steps: 6 });
  await page.mouse.up();
  const sized = await box();
  expect(Math.round(sized.width - shifted.width)).toBe(100);
  expect(Math.round(sized.height - shifted.height)).toBe(-100);
  expect(Math.round(sized.x + sized.width)).toBe(Math.round(shifted.x + shifted.width));

  // The page around it is in use: its tabs switch while the chat is open.
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.locator("[data-versions]")).toBeVisible();
  await expect(dock(page)).toBeVisible();
  await page.screenshot({ path: "test-results/dock-window.png" });

  // Opened again on another visit, it is where it was left; a double click puts it back.
  await page.reload();
  await openDock(page);
  expect(await box()).toEqual(sized);
  await header.dblclick();
  expect(await box()).toEqual(start);
});

test.describe("with the model", () => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the agent runtime's model key");

  test("asked about the page a person is on, the agent reads that resource and answers from it", async ({ page, request }) => {
    test.setTimeout(300_000);
    const as = await api(request);
    const { pages } = await aPageOfEveryKind(as);
    const chats: string[] = [];
    forgetDocks(as, () => chats);
    const at = (kind: string) => pages.find(p => p.kind === kind) as PageOf;
    const turnOver = async () => {
      await expect(dock(page).locator("button[aria-label='Stop generating']")).toBeVisible({ timeout: 20_000 });
      await expect(dock(page).locator("button[aria-label='Send message']")).toBeVisible({ timeout: 240_000 });
    };
    const chatOf = async () => {
      const rid = (await dock(page).getAttribute("data-chat-dock")) as string;
      expect(rid).toMatch(/^[0-9a-f-]{36}$/);
      chats.push(rid);
      return rid;
    };
    /** The tools the agent called in a chat, in order. */
    const toolsOf = async (rid: string) => {
      const { items } = (await as("GET", `/conversations/${rid}/messages?limit=500`)) as { items: { parts: { type: string; toolName?: string }[] }[] };
      return items.flatMap(m => m.parts.filter(p => p.type === "tool_call").map(p => p.toolName as string));
    };

    await signIn(page);
    // A dataset: "this" is the dataset on the page, and its columns come from its file.
    await page.goto(at("dataset").path);
    await openDock(page);
    await askInDock(page, "What columns does this have? List their names.");
    await turnOver();
    const aboutData = await dock(page).locator('[data-message-role="assistant"]').last().innerText();
    for (const column of ["SepalLengthCm", "PetalWidthCm", "Species"]) expect(aboutData).toContain(column);
    expect(await toolsOf(await chatOf())).toContain("read_dataset_file");

    // A workflow: the agent reads the one on the page, not one it finds by searching.
    await page.goto(at("workflow").path);
    await openDock(page);
    await askInDock(page, "Which operators does this have, and what does it compute? Do not run it.");
    await turnOver();
    const aboutWorkflow = await dock(page).locator('[data-message-role="assistant"]').last().innerText();
    expect(aboutWorkflow).toMatch(/Aggregate/i);
    expect(aboutWorkflow).toMatch(/PetalLengthCm|petal length/i);
    const tools = await toolsOf(await chatOf());
    expect(tools).toContain("get_workflow");
    expect(tools).not.toContain("create_workflow");
    await page.screenshot({ path: "test-results/dock-model.png", fullPage: true });
  });
});
