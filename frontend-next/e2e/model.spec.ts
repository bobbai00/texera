import { expect, type Locator, test } from "@playwright/test";
import { api, cleanups, type Envelope, inTurn, signIn, tidyUp, workAtHome } from "./support";

// A model says what it reads and what it adds as a picture: the input's columns on one side, the
// model in the middle, the output's columns on the other, each column with its type. Where there
// is no room across, the three stand one under the other. A model's card says the same in two
// lines. No model is called: the version is two small files and the contract it is committed with.

test.afterEach(tidyUp);

const CONTRACT = {
  framework: "python",
  entry: "predict.py",
  inputs: [
    { attributeName: "age_years", attributeType: "integer" },
    { attributeName: "sex", attributeType: "string" },
    { attributeName: "creatinine_mg_dl", attributeType: "double" },
  ],
  outputs: [
    { attributeName: "egfr", attributeType: "double" },
    { attributeName: "ckd_stage", attributeType: "string" },
  ],
};

const box = async (of: Locator) => {
  const b = await of.boundingBox();
  if (!b) throw new Error("not on the page");
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
};

test("a model's page draws what it reads, the model, and what it adds; its card says it in two lines", async ({ page, request }) => {
  test.setTimeout(180_000);
  const alice = await api(request);
  const stamp = Date.now();
  const project: Envelope = await alice("POST", "/projects", { name: `a model to read ${stamp}`, spec: {} });
  const P = project.metadata.rid;
  const model: Envelope = await alice("POST", "/models", { name: `Kidney function ${stamp}`, description: "Estimated kidney function from age, sex and serum creatinine.", parent: P, spec: { framework: "python", task: "regression" } });
  const M = model.metadata.rid;
  await alice("PUT", `/models/${M}/files/predict.py`, "def load(directory):\n    return None\n\n\ndef predict(model, frame):\n    return frame\n", "text/x-python");
  await alice("PUT", `/models/${M}/files/README.md`, "# Kidney function\n\nA published clinical equation, computed as written.\n", "text/markdown");
  await alice("POST", `/models/${M}/commit`, { message: "the equation", contract: CONTRACT });
  const conversation: Envelope = await alice("POST", "/conversations", { name: `which model ${stamp}`, parent: P, spec: {} });
  const C = conversation.metadata.rid;
  cleanups.push(async () => {
    await alice.attempt("DELETE", `/resources/${C}`);
    await alice.attempt("DELETE", `/resources/${M}`);
    await alice.attempt("DELETE", `/projects/${P}`);
    await workAtHome(alice);
  });
  const agent = await inTurn(request, alice, C);
  await agent("POST", `/conversations/${C}/messages`, { turn: agent.turn, role: "assistant", parts: [{ type: "text", text: `One model fits:\n\n- ${model.metadata.uri}@1\n\nIt needs three columns.` }] });
  await agent.end();

  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/models/${M}`);
  const picture = page.locator("[data-model-contract]");
  const [input, node, output] = [picture.locator('[data-model-side="input"]'), picture.locator("[data-model-node]"), picture.locator('[data-model-side="output"]')];

  // Each side says what it is in words, and lists its columns in the contract's order, each with its type.
  await expect(input).toContainText("Input");
  await expect(input).toContainText("Reads 3 columns from each row");
  await expect(output).toContainText("Output");
  await expect(output).toContainText("Adds 2 columns to each row");
  await expect(input.locator("[data-model-column]")).toHaveText(["age_yearsinteger", "sexstring", "creatinine_mg_dldouble"]);
  await expect(output.locator("[data-model-column]")).toHaveText(["egfrdouble", "ckd_stagestring"]);
  // No column of one side stands on the other.
  await expect(input.locator('[data-model-column="egfr"]')).toHaveCount(0);
  await expect(output.locator('[data-model-column="age_years"]')).toHaveCount(0);
  // The model stands between them, by its name and how it is called.
  await expect(node).toContainText(model.metadata.name);
  await expect(node).toContainText("python · predict.py");
  const [i, n, o] = [await box(input), await box(node), await box(output)];
  expect(i.right, "the input is left of the model").toBeLessThan(n.left);
  expect(n.right, "the model is left of the output").toBeLessThan(o.left);
  expect(Math.abs(i.top - o.top), "both sides start on one line").toBeLessThan(2);
  // The picture comes first; the model's own words follow it.
  await expect(page.locator("[data-model-card]")).toContainText("A published clinical equation");
  expect((await box(picture)).bottom).toBeLessThanOrEqual((await box(page.locator("[data-model-card]"))).top);
  await page.screenshot({ path: "test-results/model-page.png" });

  // Without room across, the same three stand one under the other, in the same order.
  await page.setViewportSize({ width: 820, height: 1000 });
  await expect.poll(async () => (await box(node)).top - (await box(input)).bottom).toBeGreaterThan(0);
  expect((await box(output)).top).toBeGreaterThan((await box(node)).bottom);
  await page.screenshot({ path: "test-results/model-page-narrow.png" });

  // In a chat, the model's card says what it reads and what it adds.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/conversations/${C}`);
  const card = page.locator('[data-part="resources"] [data-resource-card="model"]');
  await expect(card).toContainText(model.metadata.name);
  const lines = card.locator("[data-model-signature]");
  await expect(lines).toContainText("Reads");
  await expect(lines).toContainText("age_years, sex, creatinine_mg_dl");
  await expect(lines).toContainText("Adds");
  await expect(lines).toContainText("egfr, ckd_stage");
  await page.screenshot({ path: "test-results/model-card.png" });
});
