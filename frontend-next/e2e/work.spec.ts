// How the agent goes from reading to changing things, in the browser: a chat's work mode is
// chosen in its box; in manual mode the agent says its plan, and each change it asks to make
// waits on an approval card until the person approves it.
import { expect, test } from "@playwright/test";
import { api, ask, cleanups, conversationOf, IRIS_QUESTION, openChat, pick, signIn, tidyUp, withIris, workIn } from "./support";

test.afterEach(tidyUp);

test("a chat's work mode is chosen in its box, and the chat keeps the choice", async ({ page, request }) => {
  const call = await api(request);
  await signIn(page);
  const rid = await openChat(page, call, `work mode ${Date.now()}`);
  const box = page.locator("[data-composer]");
  const spec = async () => (await call("GET", `/conversations/${rid}`)).spec as Record<string, unknown>;

  await expect(box.getByLabel("Changes")).toHaveText("Auto");
  expect(await spec()).toEqual({});
  await pick(page, box.getByLabel("Changes"), "Manual");
  await expect(box.getByLabel("Changes")).toHaveText("Manual");
  await expect.poll(spec).toEqual({ workMode: "manual" });
  const runsWith = await call("GET", `/conversations/${rid}/settings`);
  expect(runsWith.workMode).toEqual({ mode: "manual", from: "chat" });
});

test("in manual mode the agent says its plan, and each change waits for an approval", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(420_000);
  const asAlice = await api(request);
  const iris = await withIris(asAlice, "manual work e2e");
  // Every chat of this project asks before each change.
  await asAlice("PUT", `/projects/${iris.project}`, { spec: { defaults: { workMode: "manual" } } });
  let conversation: string | undefined;
  cleanups.push(() => iris.clear(conversation));

  await signIn(page);
  await workIn(page, iris.name);
  await ask(page, IRIS_QUESTION);
  conversation = conversationOf(page);
  await expect(page.locator("[data-composer]").getByLabel("Changes")).toHaveText("Manual");

  // The plan comes before the first change, and names what the agent will make.
  await expect(page.locator('[data-part="plan"]').first()).toBeVisible({ timeout: 240_000 });

  // Approve each change as it comes, until the answer is there. Nothing is made unapproved.
  const answer = page.locator('[data-message-role="assistant"]').last();
  const waiting = page.locator('[data-part="approval"][data-approval-state="pending"]');
  let approved = 0;
  for (let round = 0; round < 8; round++) {
    await expect(waiting.or(answer.getByText(/1\.46/))).toBeVisible({ timeout: 240_000 });
    if ((await waiting.count()) === 0) break;
    if (approved === 0) {
      // Before the first approval nothing exists yet: the chat made no workflow.
      const made: { resource: { kind: string }; made: boolean }[] = await asAlice("GET", `/conversations/${conversation}/resources`);
      expect(made.filter(m => m.made && m.resource.kind === "workflow")).toEqual([]);
      await waiting.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/manual-work-approval.png" });
    }
    await waiting.first().locator("[data-approve]").click();
    await expect(page.locator(`[data-approval-decided="approved"]`)).toHaveCount(approved + 1, { timeout: 60_000 });
    approved += 1;
  }
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await expect(answer).toContainText(/5\.55/);
  // At least the workflow and its run were approved, by alice.
  expect(approved).toBeGreaterThanOrEqual(2);
  const messages: { items: { role: string; parts: { type: string; state?: string; decidedBy?: string }[] }[] } = await asAlice("GET", `/conversations/${conversation}/messages`);
  const decisions = messages.items.flatMap(m => m.parts.filter(p => p.type === "approval"));
  expect(decisions.length).toBe(approved);
  for (const d of decisions) expect(d.state).toBe("approved");
  await page.screenshot({ path: "test-results/manual-work.png", fullPage: true });
});
