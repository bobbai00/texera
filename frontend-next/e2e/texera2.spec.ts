import { type Browser, expect, test } from "@playwright/test";
import { AGENT, api, ask, cleanups, confirmDelete, conversationOf, createdIn, discard, IRIS_QUESTION, type Made, openChat, operatorCard, passwordOf, pick, say, signIn, tidyUp, withIris, workAtHome, workIn, toConfigure } from "./support";

// The pages against the real stack: sign in through Keycloak, start a chat by saying something,
// attach a CSV (the chat's own file, in no list) and see it as a card; the agent every chat runs,
// on show; the project a person works in; what a chat runs with, chosen in its box; a turn that
// fails and says why; a long answer that ends up on screen; custom operators; a unit made with
// a size; an execution's lineage; two people in one chat; an execution that is paused and
// resumed. The real-model scenarios run when the agent runtime has a key
// (TEXERA_E2E_SKIP_MODEL unset).

test.afterEach(tidyUp);

// Signing in is Keycloak's, on a page in Texera's look: the app's page, card, colours and logo.
test("the sign-in page wears Texera's look", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-sign-in]").first().click();
  await expect(page.locator("#kc-login")).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"][href*="/login/texera/css/texera.css"]')).toHaveCount(1);
  expect(await page.locator("#kc-header-wrapper").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("texera-logo.png");
  await page.screenshot({ path: "test-results/sign-in.png" });
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill(passwordOf("alice"));
  await page.locator("#kc-login").click();
  await expect(page.locator("[data-new-chat]")).toBeVisible();
});

test("signs in, starts a chat by saying something and attaches a CSV that stays the chat's", async ({ page, request }) => {
  await signIn(page);
  // Nothing to pick before talking. The box says what a chat runs with: the platform's agent and
  // its model. Where an execution runs is not the chat's to choose.
  await expect(page.locator("[data-start-chat]")).toHaveCount(0);
  const box = page.locator("[data-new-chat] [data-composer]");
  await expect(box.locator(`[data-chat-agent="${AGENT}"]`)).toBeVisible();
  await expect(box.getByLabel("Model")).toHaveText("anthropic-platform");
  await expect(box.getByLabel("Computing unit")).toHaveCount(0);

  // Attach a CSV and send: the first message makes the chat, and the upload is the chat's file
  // before the agent is asked: in no list of the project until someone keeps it.
  await page.locator("[data-attach-input]").setInputFiles({
    name: "penguins.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("species,island,bill_length_mm\nAdelie,Torgersen,39.1\nGentoo,Biscoe,46.1\n"),
  });
  await ask(page, "What is in this file?");
  const call = await api(request);
  const rid = conversationOf(page);
  cleanups.push(() => call.attempt("DELETE", `/resources/${rid}`));
  // The chat is the person's own project's, and stores nothing: nothing was chosen for it.
  const chat = await call("GET", `/conversations/${rid}`);
  expect(chat.spec).toEqual({});
  expect(chat.metadata.project).toBe((await call("GET", "/me")).homeProject);
  await expect(page.locator('[data-resource-card="dataset"]').first()).toBeVisible();
  const uploaded = (await page.locator('[data-resource-card="dataset"]').first().getAttribute("data-rid")) as string;
  cleanups.push(() => call.attempt("DELETE", `/resources/${uploaded}`));
  const inList = ((await call("GET", `/datasets?project=${chat.metadata.project}&limit=200`)) as { items: { metadata: { rid: string } }[] }).items;
  expect(inList.map(d => d.metadata.rid)).not.toContain(uploaded);

  // The dataset opens beside the chat and shows its file, named by its URI.
  await page.locator('[data-resource-card="dataset"] [aria-label="Open beside"]').first().click();
  const view = page.locator('[data-side-panel] [data-resource-view="dataset"]');
  await expect(view).toBeVisible();
  await expect(view.locator('[data-file="penguins.csv"]')).toBeVisible();
  await expect(view.locator("[data-file-uri]")).toContainText(/texera:\/\/datasets\/.+@1\/files\/penguins\.csv/);
  await expect(page).toHaveURL(/panel=datasets(%2F|\/)/);
  // The link carries the panel: reloading it brings the same view back.
  await page.reload();
  await expect(page.locator('[data-side-panel] [data-resource-view="dataset"]')).toBeVisible();
  await expect(page.locator('[data-side-panel] [data-file="penguins.csv"]')).toBeVisible();
  // What was attached stays a card of the person's message and a resource of the chat, with no URI among their words.
  const mine = page.locator('[data-message-role="user"]').first();
  await expect(mine.locator('[data-resource-card="dataset"]')).toBeVisible();
  await expect(mine).toContainText("What is in this file?");
  await expect(mine.getByText("texera://")).toHaveCount(0);
  // A chat that has not started work is the whole page. What it worked from is in its details,
  // beside it: the attached dataset, dimmed, made elsewhere; unfolded, its version and the
  // version's file.
  await page.locator("[data-side-panel]").getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator("[data-chat-tree]")).toHaveCount(0);
  await page.getByLabel("Open the chat's details beside").click();
  const tree = page.locator("[data-side-panel] [data-chat-tree]");
  const attached = tree.locator('[data-tree-section="dataset"] [data-tree-resource="dataset"][data-made="false"]');
  await expect(attached).toBeVisible();
  await attached.getByRole("button", { name: /^Unfold / }).first().click();
  await expect(attached.locator('[data-tree-version="1"] [data-tree-file="penguins.csv"]')).toBeVisible();
  await page.screenshot({ path: "test-results/chat-with-dataset.png", fullPage: true });
});

// A turn that cannot start, for real: the chat chooses a model endpoint whose credential holds
// no key, so the agent cannot be built and no model is called. The person must see why, and
// keep seeing it.
test("a turn that fails says why, and the chat keeps saying it", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const credential = await call("POST", "/credentials", { name: `no key ${stamp}`, spec: { kind: "api_key", scope: "nowhere" } });
  const endpoint = await call("POST", "/model-endpoints", { name: `no key ${stamp}`, spec: { provider: "anthropic", model: "claude-haiku-5-5", credential: credential.metadata.uri } });
  const conversation = await call("POST", "/conversations", { name: `keyless chat ${stamp}`, spec: { modelEndpoint: endpoint.metadata.uri } });
  cleanups.push(async () => {
    for (const r of [conversation, endpoint, credential]) await call.attempt("DELETE", `/resources/${r.metadata.rid}`);
  });

  await signIn(page);
  await page.goto(`/conversations/${conversation.metadata.rid}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await say(page, "Hello?");
  const error = page.locator('[data-part="error"]');
  await expect(error).toBeVisible({ timeout: 30_000 });
  const reason = await error.innerText();
  expect(reason.trim()).not.toBe("");
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible();
  // It is still there once the catalog's copy of the turn has replaced the live one, and after a reload.
  await page.waitForTimeout(1500);
  await expect(error).toHaveCount(1);
  await expect(error).toHaveText(reason);
  await page.reload();
  await expect(page.locator('[data-message-role="user"]', { hasText: "Hello?" })).toBeVisible();
  await expect(page.locator('[data-part="error"]')).toHaveText(reason);
  await page.screenshot({ path: "test-results/failed-turn.png", fullPage: true });
});

// The agent every chat runs is on show: what it is made of, and that it is Texera's, which every
// project inherits and only Texera's admins change.
test("the agent every chat runs is on show and is not alice's to change", async ({ page }) => {
  await signIn(page);
  await toConfigure(page, "agent-template");
  await expect(page.locator('[data-library="agent-template"]').getByRole("heading", { name: "Agents" })).toBeVisible();
  // Texera holds it: there is none to make here.
  await expect(page.locator('[data-new="agent-template"]')).toHaveCount(0);
  const row = page.locator('[data-resource-row="agent-template"]').filter({ hasText: AGENT });
  await expect(row.locator("[data-inherited-from]")).toHaveText("from Texera");
  await row.getByRole("button", { name: AGENT }).click();
  const view = page.locator('[data-resource-view="agent-template"]');
  // Its prompt, its model, its skills and its servers are there to read, and not to edit.
  await expect(view.locator('[data-field="prompt"]')).toHaveValue(/You are the Texera Agent/);
  await expect(view.locator('[data-field="prompt"]')).toBeDisabled();
  await expect(view.locator("[data-mcp-binding]")).toHaveCount(2);
  await expect(view.locator("[data-resource-name]")).toBeDisabled();
  await expect(view.locator("[data-save-template]")).toHaveCount(0);
  await expect(view.getByLabel(/^Delete/)).toHaveCount(0);
  await view.getByRole("tab", { name: "Access" }).click();
  await expect(view.locator('[data-visibility="through-project"]')).toContainText("everyone can read it: Texera is public");
  await expect(view.locator("[data-access]")).toContainText("Only someone who may share this resource");
  await page.screenshot({ path: "test-results/agent.png", fullPage: true });
});

// A project is where a person works: the lists show it and what it inherits, Texera's things among
// it, each saying where it comes from, and what is made goes into it. The pick is the person's and follows them.
test("the project a person works in scopes what they see and where things go", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const skill = { name: "a-skill", description: "For a test", body: "Nothing." };
  const lab = await call("POST", "/projects", { name: `lab ${stamp}`, spec: {} });
  const inLab = await call("POST", "/skills", { name: `lab skill ${stamp}`, parent: lab.metadata.rid, spec: skill });
  const atHome = await call("POST", "/skills", { name: `home skill ${stamp}`, spec: skill });
  cleanups.push(async () => {
    await workAtHome(call);
    const made: { items: Made[] } = await call("GET", `/skills?project=${lab.metadata.rid}`);
    for (const r of [...made.items, atHome]) await call.attempt("DELETE", `/resources/${r.metadata.rid}`);
    await call.attempt("DELETE", `/projects/${lab.metadata.rid}`);
  });
  await signIn(page);
  const rows = page.locator('[data-resource-row="skill"]');
  const row = (name: string) => rows.filter({ hasText: name });

  // Personal until another is picked: the person's own and what it inherits, not the lab's.
  await expect(page.getByLabel("Project", { exact: true })).toHaveText("Personal");
  await toConfigure(page, "skill");
  await expect(row(`home skill ${stamp}`)).toBeVisible();
  await expect(row("texera-workflows").locator("[data-inherited-from]")).toHaveText("from Texera");
  await expect(row(`home skill ${stamp}`).locator("[data-inherited-from]")).toHaveCount(0);
  await expect(row(`lab skill ${stamp}`)).toHaveCount(0);

  // In the lab: the lab's and what it inherits.
  await workIn(page, `lab ${stamp}`);
  await expect(row(`lab skill ${stamp}`)).toBeVisible();
  await expect(row("texera-workflows").locator("[data-inherited-from]")).toHaveText("from Texera");
  await expect(row(`home skill ${stamp}`)).toHaveCount(0);

  // What is made goes into the lab.
  await page.locator('[data-new="skill"]').click();
  await page.locator('[data-new-resource="skill"] input').first().fill(`made in the lab ${stamp}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/skills\//);
  const inTheLab: { items: Array<{ metadata: { name: string } }> } = await call("GET", `/skills?project=${lab.metadata.rid}`);
  expect(inTheLab.items.map(r => r.metadata.name).sort()).toEqual([`lab skill ${stamp}`, `made in the lab ${stamp}`]);
  expect(inLab.metadata.project).toBe(lab.metadata.rid);

  // The pick follows the person: it is there after a reload, and a chat starts in the lab.
  await page.reload();
  await expect(page.getByLabel("Project", { exact: true })).toHaveText(`lab ${stamp}`);
  await page.screenshot({ path: "test-results/project-scope.png", fullPage: true });

  // Every project at once.
  await workIn(page, "All projects");
  await toConfigure(page, "skill");
  await expect(row(`lab skill ${stamp}`)).toBeVisible();
  await expect(row(`home skill ${stamp}`)).toBeVisible();
});

// A project inherits from another, up to Texera: its page says from which, what its work runs
// with and where each value comes from. Its admins say what it is for, choose its people and their
// roles, see what inherits from it and send any of that back to Texera; everyone sees their own
// role; and the app wears a project's look inside it.
test("a project's page says what it inherits and runs with, and its admins manage it", async ({ page, request, browser }) => {
  const call = await api(request);
  const stamp = Date.now();
  const lab = await call("POST", "/projects", { name: `lab ${stamp}`, spec: { defaults: { workMode: "manual" } } });
  const study = await call("POST", "/projects", { name: `study ${stamp}`, base: lab.metadata.rid, spec: { branding: { name: `Study look ${stamp}` } } });
  cleanups.push(async () => {
    await workAtHome(call);
    await call.attempt("DELETE", `/projects/${study.metadata.rid}`);
    await call.attempt("DELETE", `/projects/${lab.metadata.rid}`);
  });
  const texera = (await call("GET", "/me")).rootProject as string;
  const bob = (await (await api(request, "bob"))("GET", "/me")).principal.pid as string;
  await signIn(page);
  await page.goto(`/projects/${study.metadata.rid}`);
  const view = page.locator('[data-resource-view="project"]');
  await expect(view.locator('[data-my-role="admin"]')).toBeVisible();
  await view.getByRole("tab", { name: "Settings" }).click();
  const settings = view.locator("[data-project-settings]");
  await expect(settings.locator(`[data-inherits="${lab.metadata.rid}"]`)).toBeVisible();
  const mode = settings.locator('[data-setting="defaults.workMode"]');
  await expect(mode).toContainText("manual");
  await expect(mode.locator("[data-setting-from]")).toHaveText(`from lab ${stamp}`);
  await expect(settings.locator('[data-setting="defaults.agentTemplate"] [data-setting-from]')).toHaveText("from Texera");
  await expect(settings.locator('[data-setting="branding.name"] [data-setting-from]')).toHaveText("set here");
  // What it is for, in its admin's words.
  await settings.locator("[data-project-description]").fill(`A study of the lab's ${stamp}`);
  await settings.locator("[data-save-description]").click();
  await expect.poll(async () => (await call("GET", `/projects/${study.metadata.rid}`)).metadata.description).toBe(`A study of the lab's ${stamp}`);
  await page.screenshot({ path: "test-results/project-settings.png", fullPage: true });

  // Its people: alice, who made it, is its admin; she adds bob as a member, then makes him a viewer.
  await view.getByRole("tab", { name: "People" }).click();
  await expect(view.locator('[data-grant="owner"]')).toContainText("admin");
  await view.getByLabel("Principal").fill("bob");
  await view.locator('[data-principal="Bob Builder"]').click();
  await view.getByLabel("Relation").selectOption("editor");
  await view.locator("[data-grant-button]").click();
  const bobs = view.locator('[data-grant="editor"]').filter({ hasText: "Bob Builder" });
  await expect(bobs.locator("[data-change-role]")).toHaveValue("editor");
  await bobs.locator("[data-change-role]").selectOption("viewer");
  await expect(view.locator('[data-grant="viewer"]').filter({ hasText: "Bob Builder" })).toBeVisible();
  const grants: Array<{ principal: string; relation: string }> = await call("GET", `/resources/${study.metadata.rid}/grants`);
  expect(grants.find(g => g.principal === bob)?.relation).toBe("viewer");
  await expect(view.locator("[data-roles]")).toContainText("An admin changes the project itself");
  await page.screenshot({ path: "test-results/project-people.png", fullPage: true });

  // Bob sees his own role and who is in the project, and changes neither it nor its settings.
  const bobsPage = await browserOf(browser, "bob");
  await bobsPage.goto(`/projects/${study.metadata.rid}`);
  const bobsView = bobsPage.locator('[data-resource-view="project"]');
  await expect(bobsView.locator('[data-my-role="viewer"]')).toBeVisible();
  await bobsView.getByRole("tab", { name: "People" }).click();
  await expect(bobsView.locator('[data-grant="owner"]')).toContainText("Alice Liddell");
  await expect(bobsView.locator('[data-grant="owner"]')).toContainText("admin");
  await expect(bobsView.locator('[data-grant="viewer"]')).toContainText("Bob Builder");
  await expect(bobsView.locator("[data-change-role]")).toHaveCount(0);
  await expect(bobsView.locator("[data-grant-form]")).toHaveCount(0);
  await expect(bobsView.locator("[data-toggle-visibility]")).toHaveCount(0);
  await expect(bobsView.locator("[data-people-readonly]")).toHaveText("Only its admins change who is in it.");
  await bobsPage.screenshot({ path: "test-results/project-people-as-a-viewer.png", fullPage: true });
  await bobsView.getByRole("tab", { name: "Settings" }).click();
  await expect(bobsView.locator("[data-project-description]")).toHaveCount(0);
  await expect(bobsView.locator("[data-base-select]")).toHaveCount(0);

  // The lab's admin sees that the study inherits from the lab, and sends it back to Texera: the
  // lab's work mode no longer holds there.
  await page.goto(`/projects/${lab.metadata.rid}`);
  await view.getByRole("tab", { name: "Settings" }).click();
  const inheritor = settings.locator(`[data-inherited-by] [data-inheritor="study ${stamp}"]`);
  await expect(inheritor).toBeVisible();
  await inheritor.locator("[data-send-back]").click();
  await expect(settings.locator("[data-inherited-by]")).toContainText(`No project inherits from lab ${stamp}`);
  expect((await call("GET", `/projects/${study.metadata.rid}`)).metadata.base).toBe(texera);
  await page.goto(`/projects/${study.metadata.rid}`);
  await view.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.locator(`[data-inherits="${texera}"]`)).toBeVisible();
  await expect(mode).toContainText("auto");

  // Working in it, the app wears its look.
  await page.locator("[data-work-here]").click();
  await expect(page.locator("[data-look]")).toHaveAttribute("data-look", `Study look ${stamp}`);
});

/** Another person's own browser, signed in. */
async function browserOf(browser: Browser, user: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  cleanups.push(() => context.close());
  return page;
}

test("a project made in the app is worked in at once, and what is made then goes into it", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const name = `made here ${stamp}`;
  let project: string | undefined;
  cleanups.push(async () => {
    await workAtHome(call);
    if (!project) return;
    for (const plural of ["conversations", "workflows"]) {
      const made: { items: Made[] } = await call("GET", `/${plural}?project=${project}`);
      for (const r of made.items) await call.attempt("DELETE", `/resources/${r.metadata.rid}`);
    }
    await call.attempt("DELETE", `/projects/${project}`);
  });
  await signIn(page);
  await expect(page.getByLabel("Project", { exact: true })).toHaveText("Personal");

  // Making a project is choosing to work in it: the sidebar says so, and so does its page.
  await page.locator('[data-library-link="project"]').click();
  await page.locator('[data-new="project"]').click();
  await page.locator('[data-new-resource="project"] input').first().fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/projects\//);
  project = /\/projects\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
  await expect(page.getByLabel("Project", { exact: true })).toHaveText(name);
  await expect(page.locator("[data-working-here]")).toBeVisible();
  expect((await call("GET", "/me")).preferences.project).toBe(project);

  // A workflow made now goes into it, and the dialog says where before it is made.
  await page.locator('[data-library-link="workflow"]').click();
  await page.locator('[data-new="workflow"]').click();
  const dialog = page.locator('[data-new-resource="workflow"]');
  await expect(page.getByRole("dialog")).toContainText(`New workflow in ${name}`);
  await expect(dialog).toHaveAttribute("data-new-in", project);
  await dialog.locator("input").first().fill(`in the new project ${stamp}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/workflows\//);
  const workflow = /\/workflows\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
  expect((await call("GET", `/workflows/${workflow}`)).metadata.project).toBe(project);

  // So does a chat started from the home page.
  await page.locator("[data-new-chat-link]").click();
  await expect(page.locator("[data-new-chat]")).toHaveAttribute("data-new-chat-in", project);
  await page.route("**/agents/conversations/*/ag-ui", route => route.abort());
  await say(page, "hello");
  await expect(page).toHaveURL(/\/conversations\//);
  expect((await call("GET", `/conversations/${conversationOf(page)}`)).metadata.project).toBe(project);

  // A project's page says whether the person works there, and makes it so in one click.
  const home = (await call("GET", "/me")).homeProject as string;
  await page.goto(`/projects/${home}`);
  await expect(page.locator("[data-working-here]")).toHaveCount(0);
  await page.locator("[data-work-here]").click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveText("Personal");
  await expect(page.locator("[data-working-here]")).toBeVisible();
});

test("with every project in view, the app asks which project a new thing goes into", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const lab = await call("POST", "/projects", { name: `asked lab ${stamp}`, spec: {} });
  const home = (await call("GET", "/me")).homeProject as string;
  cleanups.push(async () => {
    await workAtHome(call);
    for (const where of [lab.metadata.rid, home])
      for (const plural of ["conversations", "skills"]) {
        const made: { items: (Made & { metadata: { name: string } })[] } = await call("GET", `/${plural}?project=${where}&limit=200`);
        for (const r of made.items) if (where !== home || r.metadata.name.includes(String(stamp))) await call.attempt("DELETE", `/resources/${r.metadata.rid}`);
      }
    await call.attempt("DELETE", `/projects/${lab.metadata.rid}`);
  });
  await signIn(page);
  await workIn(page, "All projects");
  await expect(page.getByLabel("Project", { exact: true })).toHaveText("All projects");

  // The dialog asks, and makes nothing until it is told.
  await toConfigure(page, "skill");
  await page.locator('[data-new="skill"]').click();
  const dialog = page.locator('[data-new-resource="skill"]');
  await dialog.locator("input").first().fill(`asked skill ${stamp}`);
  await expect(page.getByRole("dialog")).not.toContainText("New skill in");
  await expect(page.getByRole("button", { name: "Create" })).toBeDisabled();
  await pick(page, page.getByLabel("Project to make it in"), `asked lab ${stamp}`);
  await expect(dialog).toHaveAttribute("data-new-in", lab.metadata.rid);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/skills\//);
  const inLab: { items: { metadata: { name: string } }[] } = await call("GET", `/skills?project=${lab.metadata.rid}`);
  expect(inLab.items.map(r => r.metadata.name)).toEqual([`asked skill ${stamp}`]);

  // So does the chat box: nothing can be sent until a project is chosen.
  await page.locator("[data-new-chat-link]").click();
  const box = page.locator("[data-new-chat]");
  await expect(box).toHaveAttribute("data-new-chat-in", "");
  await expect(box).toContainText("Choose the project this chat goes into.");
  await page.getByLabel("Message", { exact: true }).fill("hello");
  await expect(page.getByLabel("Send message")).toBeDisabled();
  await pick(page, page.getByLabel("Project for this chat"), `asked lab ${stamp}`);
  await expect(box).toHaveAttribute("data-new-chat-in", lab.metadata.rid);
  await page.route("**/agents/conversations/*/ag-ui", route => route.abort());
  await page.getByLabel("Send message").click();
  await expect(page).toHaveURL(/\/conversations\//);
  expect((await call("GET", `/conversations/${conversationOf(page)}`)).metadata.project).toBe(lab.metadata.rid);
  // Nothing went to the person's own project behind their back.
  const atHome: { items: { metadata: { name: string } }[] } = await call("GET", `/skills?project=${home}&limit=200`);
  expect(atHome.items.filter(r => r.metadata.name.includes(String(stamp)))).toEqual([]);
});

test("the sidebar collapses to a rail, and nothing lies over a page's header", async ({ page, request }) => {
  const call = await api(request);
  const home = (await call("GET", "/me")).homeProject as string;
  await signIn(page);
  await page.goto(`/projects/${home}`);
  const header = page.locator("[data-resource-header]");
  await expect(header).toBeVisible();
  await page.getByLabel("Collapse sidebar").click();
  const rail = page.locator("[data-sidebar-rail]");
  await expect(rail).toBeVisible();
  // The way back is in the rail, beside the page, not over the page's own icon.
  const expand = (await rail.getByLabel("Expand sidebar").boundingBox()) as { x: number; width: number };
  const top = (await header.boundingBox()) as { x: number };
  expect(expand.x + expand.width).toBeLessThanOrEqual(top.x);
  await page.screenshot({ path: "test-results/sidebar-rail.png" });
  await rail.getByLabel("Expand sidebar").click();
  await expect(rail).toHaveCount(0);
  await expect(page.getByLabel("Project", { exact: true })).toBeVisible();
});

// What a chat runs with is chosen in its box and stored as the chat's choices; the catalog says
// what a turn would run with. A unit is not among them.
test("a chat's model and add-ons are chosen in its box", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const other = await call("POST", "/model-endpoints", { name: `other model ${stamp}`, spec: { provider: "anthropic", model: "claude-haiku-5-5" } });
  cleanups.push(() => call.attempt("DELETE", `/resources/${other.metadata.rid}`));
  await signIn(page);
  const rid = await openChat(page, call, `settings chat ${stamp}`);
  const spec = async () => (await call("GET", `/conversations/${rid}`)).spec as Record<string, unknown>;
  const box = page.locator("[data-composer]");

  // Untouched, the chat follows the defaults.
  await expect(box.locator(`[data-chat-agent="${AGENT}"]`)).toBeVisible();
  await expect(box.getByLabel("Model")).toHaveText("anthropic-platform");
  await expect(box.getByLabel("Computing unit")).toHaveCount(0);
  await expect(box.locator('[data-chat-add-ons="1"]')).toBeVisible();
  expect(await spec()).toEqual({});

  // Another model: the list names each endpoint and says which model it serves.
  await box.getByLabel("Model").click();
  await expect(page.getByRole("option", { name: `other model ${stamp}`, exact: true })).toContainText("claude-haiku-5-5");
  await page.keyboard.press("Escape");
  await pick(page, box.getByLabel("Model"), `other model ${stamp}`);
  await expect(box.getByLabel("Model")).toHaveText(`other model ${stamp}`);
  await expect.poll(spec).toEqual({ modelEndpoint: other.metadata.uri });

  // An add-on off: from then on the chat's add-ons are its own list.
  await box.locator("[data-chat-add-ons]").click();
  await page.locator('[data-add-on="biomcp"]').click();
  await expect.poll(spec).toEqual({ modelEndpoint: other.metadata.uri, mcpServers: [] });
  await page.keyboard.press("Escape");
  await expect(box.locator('[data-chat-add-ons="0"]')).toBeVisible();
  await page.screenshot({ path: "test-results/chat-settings.png", fullPage: true });

  // What a turn would run with says the same, and that the catalog's own server stays.
  const runsWith = await call("GET", `/conversations/${rid}/settings`);
  expect(runsWith.modelEndpoint).toEqual({ uri: other.metadata.uri, name: `other model ${stamp}`, from: "chat" });
  expect(runsWith.mcpServers.map((m: { name: string; platform: boolean }) => [m.name, m.platform])).toEqual([["catalog", true]]);
  expect(runsWith.computingUnit).toBeUndefined();
  // The chat's own page shows it too.
  await page.getByLabel("Open the chat's details beside").click();
  await expect(page.locator("[data-side-panel] [data-chat-settings]")).toContainText("chosen for this chat");
});

// The runtime's part of a turn, without a model: the messages in the catalog, then the stream.
test("a long first answer ends up on screen", async ({ page, request }) => {
  await signIn(page);
  const call = await api(request);
  const rid = await openChat(page, call, `long answer ${Date.now()}`);
  const answer = `${Array.from({ length: 90 }, (_, i) => `Paragraph ${i} of a long answer.`).join("\n\n")}\n\nThe end of the answer.`;
  await page.route(`**/agents/conversations/${rid}/ag-ui`, async route => {
    // The catalog has the turn's messages before the stream ends, as the runtime writes them
    // while it streams: the page finds the catalog's copy when the run finishes.
    const turn = await call("POST", `/conversations/${rid}/turns`, {});
    await call("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "user", parts: [{ type: "text", text: "Tell me everything." }] });
    await call("POST", `/conversations/${rid}/messages`, { turn: turn.turn, role: "assistant", template: turn.template, parts: [{ type: "text", text: answer }] });
    await call("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
    const events = [
      { type: "RUN_STARTED", threadId: rid, runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: answer },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: rid, runId: "r" },
    ];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") });
  });
  await say(page, "Tell me everything.");
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible();
  // One copy: the catalog's has replaced the live one. Until it has, the page may show the live
  // copy alone, and the browser keeps that one in place while the catalog's lands above it.
  const end = page.getByText("The end of the answer.");
  await expect(page.locator("[data-message-seq]").filter({ hasText: "The end of the answer." })).toHaveCount(1);
  await expect(end).toHaveCount(1);
  await expect(end).toBeInViewport();
  // Someone who scrolled up to read is left where they are.
  const scroller = page.locator('[data-message-role="assistant"]').first().locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]");
  await scroller.evaluate(el => {
    el.scrollTop = 0;
  });
  await expect(page.getByText("Paragraph 0 of a long answer.")).toBeInViewport();
  await page.waitForTimeout(500);
  await expect(page.getByText("Paragraph 0 of a long answer.")).toBeInViewport();
});

test("creates a custom operator from its page and finds it in a workflow's palette", async ({ page, request }) => {
  const call = await api(request);
  const madeIn = (kind: string) => new RegExp(`/${kind}/([0-9a-f-]{36})`).exec(page.url())?.[1] as string;
  await signIn(page);
  await page.locator('[data-library-link="operator"]').click();
  await expect(page.locator('[data-library="operator"]')).toBeVisible();
  await page.locator('[data-new="operator"]').click();
  const name = `E2E rank ${Date.now()}`;
  await page.locator('[data-new-resource="operator"] input').first().fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/operators\//);
  const operator = madeIn("operators");
  cleanups.push(() => call.attempt("DELETE", `/resources/${operator}`));
  const form = page.locator("[data-spec-editor='operator']");
  // A new operator is a Python function named after it, never a class; what it reads, its
  // settings and its columns are the catalog's reading of the code, not fields to fill.
  const fn = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  await expect(form.locator('[data-field="operatorType"]')).toHaveValue(fn);
  const code = form.locator('[data-field="code"]');
  await expect(code).toHaveValue(new RegExp(`@returns\\(rows=int\\)\\ndef ${fn}\\(table: pd\\.DataFrame, \\*,`));
  expect(await code.inputValue()).not.toMatch(/class |UDFOperatorV2|process_tuple/);
  await expect(form.locator('[data-field="propertiesSchema"]')).toHaveCount(0);
  // A setting typed Credential becomes a credential picker in the workflow editor.
  await code.fill((await code.inputValue()).replace('label: str = ""', 'label: str = "", api_key: Credential = None'));
  await form.locator("[data-save-spec]").click();
  await expect(form.locator("[data-save-spec]")).toBeDisabled();
  // Every save is a version, and the page shares the resource with someone found in the
  // directory, whether or not they have logged in.
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.locator("[data-versions] li")).toHaveCount(2);
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page.locator("[data-grants]")).toBeVisible();
  await page.getByLabel("Principal").fill("bob");
  await page.locator('[data-principal="Bob Builder"]').click();
  await page.locator("[data-grant-button]").click();
  await expect(page.locator('[data-grant="viewer"]').filter({ hasText: "Bob Builder" })).toBeVisible();

  // The operator is in the palette of a new workflow, typed by its URI.
  await page.locator('[data-library-link="workflow"]').click();
  await page.locator('[data-new="workflow"]').click();
  await page.locator('[data-new-resource="workflow"] input').first().fill(`E2E workflow ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("[data-workflow-view] [data-workflow-canvas]")).toBeVisible();
  const workflow = madeIn("workflows");
  cleanups.push(() => discard(call, [workflow]));
  // A new workflow opens with the operators to choose from; the one picked opens in its card.
  const palette = page.locator("[data-operator-palette]");
  await palette.getByPlaceholder("Search operators").fill("E2E rank");
  const entry = palette.locator('[data-palette-operator^="texera://operators/"]').filter({ hasText: name });
  await expect(entry).toBeVisible();
  await entry.click();
  const properties = page.locator("[data-operator-editor]");
  await expect(properties).toBeVisible();
  await expect(properties.locator("[data-credential-picker]")).toBeVisible();
  await page.screenshot({ path: "test-results/custom-operator.png", fullPage: true });
});

test("a computing unit is made from a profile, with the size asked for, and says how it differs", async ({ page, request }) => {
  const call = await api(request);
  const name = `sized unit ${Date.now()}`;
  const me = await call("GET", "/me");
  const profile: string = (await call("GET", `/projects/${me.homeProject}/settings`)).defaults.profile;
  const made = await call("GET", profile.replace("texera://", "/"));
  await signIn(page);
  await page.locator('[data-library-link="computing-unit"]').click();
  await page.locator('[data-new="computing-unit"]').click();
  const dialog = page.locator('[data-new-resource="computing-unit"]');
  await dialog.locator("input").first().fill(name);
  // The dialog proposes the profile the project inherits from Texera, and its size; the person asks for more.
  await expect(dialog.locator('[data-field="profile"]')).toHaveValue(profile);
  await expect(dialog.locator('[data-field="memory"]')).toHaveValue(made.spec.memory);
  await expect(dialog.locator('[data-field="cpu"]')).toHaveValue(made.spec.cpu);
  await dialog.locator('[data-field="memory"]').selectOption({ label: "2 GB" });
  await dialog.locator('[data-field="cpu"]').selectOption({ label: "1 core" });
  await page.screenshot({ path: "test-results/unit-new.png" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/computing-units\//);
  const rid = /\/computing-units\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
  cleanups.push(async () => {
    await call.attempt("POST", `/computing-units/${rid}/terminate`);
    await call.attempt("DELETE", `/resources/${rid}`);
  });
  const unit = await call("GET", `/computing-units/${rid}`);
  // Made from the profile's version, with its packages, at the size asked for.
  expect(unit.spec.computingNodes).toEqual([
    { name: "master", role: "master", profile: `${profile}@${made.metadata.head}`, memory: "2Gi", cpu: "1", packages: made.spec.packages },
  ]);
  expect(unit.metadata.name).toBe(name);
  // Its page says what it is made of, and how it differs from its profile.
  const madeOf = page.locator("[data-made-of]");
  await expect(madeOf.locator("[data-unit-profile]")).toContainText(`${made.metadata.name}@${made.metadata.head}`);
  await expect(madeOf.locator("[data-unit-changes]")).toContainText("memory 4 GB → 2 GB");
  await expect(madeOf.locator("[data-unit-changes]")).toContainText("CPU 2 cores → 1 core");
  await expect(madeOf.locator("[data-unit-packages]")).toContainText("pandas");
  // A package added on the page is the unit's: saved, it is one more change from the profile.
  await madeOf.locator("[data-add-package]").fill("humanize==4.11.0");
  await madeOf.getByRole("button", { name: "Add" }).click();
  await madeOf.locator("[data-save-unit]").click();
  await expect(madeOf.locator("[data-unit-changes]")).toContainText("+ humanize==4.11.0");
  await expect.poll(async () => (await call("GET", `/computing-units/${rid}`)).spec.computingNodes[0].packages).toContain("humanize==4.11.0");
  await page.screenshot({ path: "test-results/unit-made-of.png", fullPage: true });
});

test("the public unit is saved as a profile of one's own, which units can be made from", async ({ page, request }) => {
  const call = await api(request);
  const settings = (await call("GET", `/projects/${(await call("GET", "/me")).rootProject}/settings`)).defaults;
  const unit = await call("GET", settings.computingUnit.replace("texera://", "/"));
  const profile = await call("GET", unit.spec.computingNodes[0].profile.split("@")[0].replace("texera://", "/"));
  const home: string = (await call("GET", "/me")).homeProject;
  await signIn(page);
  await page.goto(`/computing-units/${unit.metadata.rid}`);
  const madeOf = page.locator("[data-made-of]");
  await expect(madeOf.locator("[data-unit-profile]")).toContainText(profile.metadata.name);
  await expect(madeOf.locator('[data-unit-changes="none"]')).toBeVisible();
  // The platform's unit is not alice's to change.
  await expect(madeOf.locator("[data-add-package]")).toHaveCount(0);
  await madeOf.locator("[data-save-as-profile]").click();
  const form = page.locator("[data-save-profile-form]");
  // The platform's profile is not saved over: only a new one, in the project alice works in.
  await expect(form.getByRole("radio")).toHaveCount(0);
  const name = `my python ${Date.now()}`;
  await form.locator("[data-profile-name]").fill(name);
  await page.screenshot({ path: "test-results/unit-save-as-profile.png" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  const found: { items: { metadata: { rid: string; name: string; project: string }; spec: { packages?: string[] } }[] } = await call(
    "GET",
    `/profiles?q=${encodeURIComponent(name)}`
  );
  const saved = found.items.find(p => p.metadata.name === name);
  expect(saved, "the profile was saved").toBeDefined();
  cleanups.push(() => call.attempt("DELETE", `/resources/${saved?.metadata.rid}`));
  expect(saved?.metadata.project).toBe(home);
  // Its packages are the unit's, each pinned once the unit has said what it installed.
  const installed: string[] = unit.status?.installed ?? [];
  const names = (packages: string[] = []) => packages.map(p => p.split(/[<>=!~;[ @]/)[0]?.toLowerCase()).sort();
  expect(names(saved?.spec.packages)).toEqual(names(unit.spec.computingNodes[0].packages));
  if (installed.length) expect(saved?.spec.packages?.every(p => installed.includes(p))).toBe(true);
  // Its page is a profile's, with what a node made from it gets.
  await page.goto(`/profiles/${saved?.metadata.rid}`);
  await expect(page.getByLabel("Profile name")).toHaveValue(name);
  await expect(page.locator('[data-resource-view="profile"]')).toContainText(saved?.spec.packages?.[0] ?? "");
  await page.screenshot({ path: "test-results/profile.png", fullPage: true });
});

test("a project keeps its results in a warehouse made for it, and an execution says where its results are", async ({ page, request }) => {
  test.setTimeout(240_000);
  const call = await api(request);
  const stamp = Date.now();
  const lab = await withIris(call, "warehouse lab");
  const made: string[] = [];
  const workflows: string[] = [];
  cleanups.push(async () => {
    // The project may still name the warehouse: a resource still named cannot go.
    await call.attempt("PUT", `/projects/${lab.project}`, { spec: {} });
    await discard(call, workflows);
    await lab.clear(undefined, made);
  });
  await signIn(page);
  await workIn(page, lab.name);

  // The deployment's warehouse is on show, inherited from Texera; a project makes its own from the same page.
  await toConfigure(page, "warehouse");
  await expect(page.locator('[data-library="warehouse"]').getByRole("heading", { name: "Warehouses" })).toBeVisible();
  await expect(page.locator('[data-resource-row="warehouse"]').filter({ hasText: "texera" }).locator("[data-inherited-from]")).toHaveText("from Texera");
  await page.locator('[data-new="warehouse"]').click();
  const dialog = page.locator('[data-new-resource="warehouse"]');
  await dialog.locator("input").first().fill(`lab results ${stamp}`);
  // The dialog proposes the deployment's store; a store of one's own is asked for its place.
  await expect(dialog.locator('[data-field="where"]')).toHaveValue("platform");
  await dialog.locator('[data-field="where"]').selectOption("own");
  await expect(dialog.locator('[data-field="endpoint"]')).toBeVisible();
  await expect(dialog.locator("[data-credential-picker]")).toBeVisible();
  await page.screenshot({ path: "test-results/warehouse-new.png", fullPage: true });
  await dialog.locator('[data-field="where"]').selectOption("platform");
  await expect(dialog.locator('[data-field="endpoint"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/warehouses\//);
  const rid = /\/warehouses\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
  made.push(rid);
  const warehouse = await call("GET", `/warehouses/${rid}`);
  expect(warehouse.metadata.project).toBe(lab.project);
  expect(warehouse.spec).toEqual({});

  // Its page says where it keeps its tables; one click makes it where the project keeps its results.
  const view = page.locator('[data-resource-view="warehouse"]');
  await expect(view.locator("[data-warehouse-place]")).toContainText("The deployment's own");
  await expect(view.locator("[data-warehouse-place]")).toContainText(warehouse.status.name);
  await view.locator('[data-warehouse-use="start"]').click();
  await expect(view.locator('[data-warehouse-default="project"]')).toContainText(`${lab.name} keeps its results here`);
  expect((await call("GET", `/projects/${lab.project}`)).spec.defaults.warehouse).toBe(warehouse.metadata.uri);

  // An execution in the project keeps its results there: its page names the warehouse and shows the rows.
  const wf = await call("POST", "/workflows", {
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
  workflows.push(wf.metadata.rid);
  const started = await call("POST", `/workflows/${wf.metadata.rid}/run`, { waitSeconds: 180, name: `mean petals, kept in the lab ${stamp}` });
  expect(started.status.phase).toBe("completed");
  expect(started.spec.warehouse).toBe(warehouse.metadata.uri);
  await page.goto(`/workflows/${wf.metadata.rid}/executions/${started.metadata.rid}`);
  const execution = page.locator("[data-execution-view]");
  await expect(execution.locator('[data-uri-chip="warehouse"]')).toHaveText(`lab results ${stamp}`);
  await expect(execution.locator("[data-port-rows]")).toBeVisible();
  await page.screenshot({ path: "test-results/warehouse-execution.png", fullPage: true });

  // It stays while the execution keeps results in it, and says why; the project lets go of it in one click.
  await page.goto(`/warehouses/${rid}`);
  await expect(view.locator('[data-warehouse-default="project"]')).toBeVisible();
  await page.screenshot({ path: "test-results/warehouse.png", fullPage: true });
  await view.locator('[data-warehouse-use="stop"]').click();
  await expect(view.locator('[data-warehouse-default="project"]')).toHaveCount(0);
  await confirmDelete(page, view.locator('[data-delete="warehouse"]'));
  await expect(page.locator("[data-delete-refused]")).toContainText(/still keep results in/);
});

test("an execution shows the file it read in its lineage, and can be kept past the retention policy", async ({ page, request }) => {
  const call = await api(request);
  const ds = await call("POST", "/datasets", { name: `lineage e2e ${Date.now()}`, spec: { format: "csv" } });
  const dsRid = ds.metadata.rid as string;
  await call("PUT", `/datasets/${dsRid}/files/flowers.csv`, "species,petal\nsetosa,1.4\nvirginica,5.5\nsetosa,1.6\n", "application/octet-stream");
  await call("POST", `/datasets/${dsRid}/commit`, { message: "flowers" });
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${dsRid}@1/files/flowers.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "avg", operatorType: "Aggregate", viewResult: true, operatorProperties: { groupByKeys: ["species"], aggregations: [{ aggFunction: "average", attribute: "petal", "result attribute": "avg" }] } },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "avg", portID: "input-0" } }],
  };
  const stamp = Date.now();
  const wf = await call("POST", "/workflows", { name: `flower means ${stamp}`, spec });
  const wfRid = wf.metadata.rid as string;
  cleanups.push(() => discard(call, [wfRid], [dsRid]));
  const started = await call("POST", `/workflows/${wfRid}/run`, { waitSeconds: 180, name: `flower means, executed ${stamp}` });
  expect(started.status.phase).toBe("completed");
  const eid = started.metadata.rid as string;

  await signIn(page);
  await page.goto(`/workflows/${wfRid}/executions/${eid}`);
  const execution = page.locator("[data-execution-view]");
  await expect(execution).toBeVisible();
  await expect(execution.locator("[data-phase]")).toHaveText("completed");
  await expect(execution.locator("[data-port-rows]")).toBeVisible();
  await execution.getByRole("tab", { name: "Lineage" }).click();
  const lineage = execution.locator("[data-lineage]");
  await expect(lineage.locator('[data-edge="used"]')).toBeVisible();
  await expect(lineage).toContainText("flowers.csv");
  await execution.locator('[data-keep-execution="free"]').click();
  await expect(execution.locator('[data-keep-execution="kept"]')).toBeVisible();
  await page.screenshot({ path: "test-results/lineage.png", fullPage: true });

  // The workflow page lists the execution, and so does the list of them across workflows.
  await page.goto(`/workflows/${wfRid}`);
  const workflow = page.locator("[data-workflow-view]");
  await expect(workflow.locator("[data-workflow-canvas]")).toBeVisible();
  await workflow.getByRole("tab", { name: /^Executions/ }).click();
  await expect(workflow.locator('[data-execution-row="completed"]').first()).toBeVisible();
  await page.locator('[data-library-link="execution"]').click();
  await expect(page.locator('[data-library="execution"]').getByRole("heading", { name: "Executions" })).toBeVisible();
  await expect(page.locator('[data-resource-row="execution"]').filter({ hasText: `flower means, executed ${stamp}` })).toBeVisible();
});

test("two people in one chat: a shared conversation shows the other's messages and turn as they happen", async ({ browser, page, request }) => {
  const alice = await api(request);
  const bob = await api(request, "bob");
  const bobPid = (await bob("GET", "/me")).principal.pid as string;
  const alicePid = (await alice("GET", "/me")).principal.pid as string;

  await signIn(page);
  const rid = await openChat(page, alice, `group chat ${Date.now()}`);
  // Sharing is membership: bob, an editor, opens the same chat in his own browser.
  await alice("PUT", `/resources/${rid}/grants/${bobPid}`, { relation: "editor" });
  const bobsBrowser = await browser.newContext();
  const bobsPage = await bobsBrowser.newPage();
  await signIn(bobsPage, "bob");
  await bobsPage.goto(`/conversations/${rid}`);
  await expect(bobsPage.locator("[data-composer]")).toBeVisible();

  // Bob's message lands on alice's page without a reload, under his name.
  await bob("POST", `/conversations/${rid}/messages`, { role: "user", parts: [{ type: "text", text: "Hello from Bob" }] });
  const fromBob = page.locator('[data-message-role="user"]', { hasText: "Hello from Bob" });
  await expect(fromBob).toBeVisible();
  await expect(fromBob.locator(`[data-message-author="${bobPid}"]`)).not.toBeEmpty();
  // And alice's on bob's, under hers; one's own messages carry no label.
  await alice("POST", `/conversations/${rid}/messages`, { role: "user", parts: [{ type: "text", text: "Hi Bob, welcome" }] });
  const fromAlice = bobsPage.locator('[data-message-role="user"]', { hasText: "Hi Bob, welcome" });
  await expect(fromAlice).toBeVisible();
  await expect(fromAlice.locator(`[data-message-author="${alicePid}"]`)).not.toBeEmpty();
  await expect(page.locator(`[data-message-author="${alicePid}"]`)).toHaveCount(0);

  // While bob's turn runs, alice sees whose turn it is and waits; when it ends she may speak.
  const turn = await bob("POST", `/conversations/${rid}/turns`, {});
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toBeVisible();
  await expect(page.getByLabel("Send message")).toBeDisabled();
  await page.screenshot({ path: "test-results/group-chat.png", fullPage: true });
  await bob("DELETE", `/conversations/${rid}/turns/${turn.turn}`);
  await expect(page.locator(`[data-turn-of="${bobPid}"]`)).toHaveCount(0);
  await bobsBrowser.close();
});

test("an execution's page follows it as it goes, and pauses and resumes it", async ({ page, request }) => {
  const call = await api(request);
  const stamp = Date.now();
  const ds = await call("POST", "/datasets", { name: `slow e2e ${stamp}`, spec: { format: "csv" } });
  const dsRid = ds.metadata.rid as string;
  const rows = Array.from({ length: 150 }, (_, i) => `${i},${(i % 7) * 1.5}`).join("\n");
  await call("PUT", `/datasets/${dsRid}/files/numbers.csv`, `id,value\n${rows}\n`, "application/octet-stream");
  await call("POST", `/datasets/${dsRid}/commit`, { message: "numbers" });
  // A function that puts out each row on its own, a fifth of a second apart.
  const code =
    "import time\n\nimport pandas as pd\n\n\n@returns(id=int, value=float)\ndef one_by_one(rows: pd.DataFrame):\n    for i in range(len(rows)):\n        time.sleep(0.2)\n        yield rows.iloc[[i]]\n";
  const oneByOne = await call("POST", "/operators", { name: `one by one ${stamp}`, spec: { implementation: { python: { code } } } });
  const spec = {
    operators: [
      { operatorID: "scan", operatorType: "CSVFileScan", operatorProperties: { fileName: `texera://datasets/${dsRid}@1/files/numbers.csv`, fileEncoding: "UTF_8", hasHeader: true } },
      { operatorID: "slow", operatorType: `${oneByOne.metadata.uri}@1`, viewResult: true, operatorProperties: {} },
    ],
    links: [{ linkID: "l1", source: { operatorID: "scan", portID: "output-0" }, target: { operatorID: "slow", portID: "input-0" } }],
  };
  const wf = await call("POST", "/workflows", { name: `slow numbers ${stamp}`, spec });
  const wfRid = wf.metadata.rid as string;
  cleanups.push(() => discard(call, [wfRid], [dsRid, oneByOne.metadata.rid as string]));

  await signIn(page);
  const started = await call("POST", `/workflows/${wfRid}/run`, { name: `slow execution ${stamp}`, fresh: true });
  await page.goto(`/workflows/${wfRid}/executions/${started.metadata.rid}`);
  const execution = page.locator("[data-execution-view]");
  await expect(execution.locator("[data-phase]")).toHaveText("running", { timeout: 90_000 });
  // The canvas shows the workflow as it runs: each operator's card says where it stands and
  // the rows it has read and put out, as the unit reports them, with no reload. A running
  // operator is plain to see: a bar moves along its card, and the arrow into it moves.
  const slow = operatorCard(page, "slow").locator("[data-operator-status]");
  await expect(slow).toHaveAttribute("data-operator-status", "running", { timeout: 30_000 });
  await expect(slow.locator("[data-operator-rows]")).toBeVisible({ timeout: 30_000 });
  await expect(slow.locator("[data-operator-working]")).toBeVisible();
  await execution.locator("[data-pause-execution]").click();
  await expect(execution.locator("[data-phase]")).toHaveText("paused", { timeout: 30_000 });
  await expect(slow).toHaveAttribute("data-operator-status", "paused", { timeout: 30_000 });
  await expect(slow.locator("[data-operator-working]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/paused-execution.png", fullPage: true });
  await execution.locator("[data-resume-execution]").click();
  await expect(execution.locator("[data-phase]")).toHaveText("running", { timeout: 30_000 });
  await expect(execution.locator("[data-phase]")).toHaveText("completed", { timeout: 90_000 });
  await expect(slow).toHaveAttribute("data-operator-status", "completed");
  await expect(slow.locator("[data-operator-rows]")).toContainText("150 rows");
  await expect(execution.locator("[data-port-rows]")).toBeVisible();
});

// The core loop with the real model: bob works in a project of his, picks a computing unit of
// his own in the chat box and asks about his iris dataset; the agent finds the data in that
// project, builds and runs a workflow there with the catalog's tools; the answer arrives on
// screen, the execution went to the unit he named in his words (the chat stores no unit), and the
// workflow is listed in the chat's tree and opens beside it.
test("the agent answers from a workflow it built, in the chat's project and on the unit named in words", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(300_000);
  const asBob = await api(request, "bob");
  const iris = await withIris(asBob, "core loop e2e");
  // A second unit at the deployment's engine, so the execution's unit tells where the agent sent it.
  const platform = (await asBob("GET", "/me")).rootProject as string;
  const units: Array<{ metadata: { uri: string }; spec: { provider: string; endpoint?: string; clientId?: string } }> = await asBob("GET", `/computing-units/available?scope=${platform}`);
  const base = units.find(u => u.spec.provider === "static");
  expect(base, "the public unit").toBeDefined();
  const unitName = `bob's unit ${Date.now()}`;
  const unit = await asBob("POST", "/computing-units", { name: unitName, parent: iris.project, spec: { provider: "static", endpoint: base?.spec.endpoint, ...(base?.spec.clientId ? { clientId: base.spec.clientId } : {}) } });
  let conversation: string | undefined;
  cleanups.push(async () => {
    await iris.clear(conversation, [unit.metadata.rid]);
  });
  await signIn(page, "bob");
  await workIn(page, iris.name);
  await ask(page, `${IRIS_QUESTION} Run it on my computing unit named "${unitName}".`);
  conversation = conversationOf(page);
  // The chat stores nothing: bob chose nothing in its box.
  expect((await asBob("GET", `/conversations/${conversation}`)).spec).toEqual({});

  const answer = page.locator('[data-message-role="assistant"]').last();
  // The averages, as the model may round them: 1.462, 4.260 and 5.552.
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await expect(answer).toContainText(/5\.55/);
  await expect(page.locator(`[data-message-template="${AGENT}"]`).first()).toBeVisible();
  // The turn is over and the end of the answer is where the person is looking.
  await expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 60_000 });
  await expect(answer.locator(":scope > *").last()).toBeInViewport();

  // Where it ran: the unit bob named, which the agent passed on. Where it was made: the project
  // the chat is in.
  const made = await createdIn<Made & { metadata: { project: string }; spec: { computingUnit?: string } }>(asBob, conversation);
  const executions = made.filter(r => r.kind === "execution");
  expect(executions.length).toBeGreaterThan(0);
  for (const execution of executions) expect(execution.spec.computingUnit).toBe(unit.metadata.uri);
  const workflows = made.filter(r => r.kind === "workflow");
  expect(workflows.length).toBeGreaterThan(0);
  for (const workflow of workflows) expect(workflow.metadata.project).toBe(iris.project);
  // The answer says what wrote it: the agent and the model.
  await expect(page.locator('[data-message-model="anthropic-platform"]').first()).toBeVisible({ timeout: 30_000 });

  // Beside the chat, the workflow it built, its version, and the execution under the version.
  await page.locator('[data-resource-view="list"]').click();
  const built = page.locator('[data-chat-tree] [data-tree-resource="workflow"][data-made="true"]').first();
  await expect(built).toBeVisible({ timeout: 30_000 });
  await expect(built.locator("[data-tree-version] [data-tree-execution]").first()).toBeVisible();
  await built.locator("[data-open-row]").first().click();
  const view = page.locator("[data-graph-focus] [data-workflow-view]").first();
  await expect(view).toBeVisible();
  await expect(view.locator("[data-workflow-canvas]").first()).toBeVisible();
  await view.getByRole("tab", { name: "Versions" }).click();
  await expect(view.locator("[data-versions] li").first()).toBeVisible();
  await view.getByRole("tab", { name: "Lineage" }).click();
  await expect(view.locator("[data-lineage]")).toContainText(/iris/i);
  await page.screenshot({ path: "test-results/core-loop.png", fullPage: true });
});

// One agent for everything: alice asks for research ideas, which the agent grounds with the bio
// tools; then for an analysis of her data, which the same agent answers from an execution, with no
// handoff; then to share the data, which it does through the catalog server.
test("one agent researches, analyzes and shares in one chat", async ({ page, request }) => {
  test.skip(!!process.env.TEXERA_E2E_SKIP_MODEL, "needs the real model");
  test.setTimeout(420_000);
  const iris = await withIris(await api(request), "one agent e2e");
  let conversation: string | undefined;
  cleanups.push(() => iris.clear(conversation));
  await signIn(page);
  await workIn(page, iris.name);
  const turnOver = () => expect(page.locator("[data-composer] button[aria-label='Send message']")).toBeVisible({ timeout: 240_000 });

  await ask(page, "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.");
  conversation = conversationOf(page);
  // It consults the literature tools before it answers, whatever they return today.
  await expect(page.locator('[data-tool="search_pubmed"]').first()).toBeVisible({ timeout: 180_000 });
  await turnOver();
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(/off-target/i);

  await say(page, "Now analyze the iris dataset in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.");
  const answer = page.locator('[data-message-role="assistant"]').last();
  await expect(answer).toContainText(/1\.46/, { timeout: 240_000 });
  await turnOver();
  // The same agent did both: the chat never changed hands.
  await expect(page.locator('[data-part="handoff"]')).toHaveCount(0);
  await expect(page.locator("[data-current-template]")).toHaveText(AGENT);
  await page.screenshot({ path: "test-results/one-agent.png", fullPage: true });

  // It shares through the catalog server: afterwards bob can read alice's iris.
  await say(page, "Share my iris dataset with Bob so he can read it.");
  await expect(page.locator('[data-tool="grant_access"][data-tool-state="done"]').first()).toBeVisible({ timeout: 180_000 });
  await turnOver();
  const asBob = await api(request, "bob");
  const bob = await asBob("GET", "/me");
  const visible = await asBob("GET", "/datasets?q=iris");
  expect(visible.items.some((d: { metadata: { name: string; owner: string } }) => d.metadata.name === "iris" && d.metadata.owner !== bob.principal.pid)).toBe(true);
});
