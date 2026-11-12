import { expect, test } from "@playwright/test";
import { api, type Caller, cleanups, type Envelope, IRIS_CSV, signIn, tidyUp } from "./support";

// A version's files are previewed by what they are: a table's first rows; markdown as the page it
// is, with its source a click away; other text as it is written; nothing for the rest. A version
// opens on its data, and without any on the first file there is something to show of.

test.afterEach(tidyUp);

const README = [
  "# Iris flowers",
  "",
  "Fisher's **150 flowers** of three species, measured in 1936.",
  "",
  "## Columns",
  "",
  "- `SepalLengthCm`: the sepal's length",
  "- `Species`: one of three",
  "",
  "| Species | Flowers |",
  "|---|---|",
  ...Array.from({ length: 14 }, (_, i) => `| setosa ${i + 1} | 50 |`),
  "",
].join("\n");
const CODEBOOK = JSON.stringify({ SepalLengthCm: "the sepal's length, in centimetres" }, null, 2);

async function datasetWith(as: Caller, name: string, files: [path: string, data: string | Buffer, type: string][]) {
  const dataset: Envelope = await as("POST", "/datasets", { name, spec: {} });
  cleanups.push(() => as.attempt("DELETE", `/resources/${dataset.metadata.rid}`));
  for (const [path, data, type] of files) await as("PUT", `/datasets/${dataset.metadata.rid}/files/${path}`, data, type);
  await as("POST", `/datasets/${dataset.metadata.rid}/commit`, { message: "first" });
  return dataset.metadata.rid;
}

test("a README is drawn as the page it is, with its source a click away, and other text reads as written", async ({ page, request }) => {
  const alice = await api(request);
  const rid = await datasetWith(alice, `iris with a readme ${Date.now()}`, [
    ["README.md", README, "text/markdown"],
    ["codebook.json", CODEBOOK, "application/json"],
    ["iris.csv", IRIS_CSV, "text/csv"],
    ["scan.bin", Buffer.from([0, 159, 146, 150, 255]), "application/octet-stream"],
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/datasets/${rid}`);

  // The data opens first, as a table.
  await expect(page.locator('[data-file-preview="table"]')).toBeVisible();
  await expect(page.locator("[data-preview-count]")).toHaveText("The first 100 rows, of 150.");

  // The README is drawn: headings, emphasis, a list and a table, and none of the signs they are written with.
  await page.locator('[data-file="README.md"]').click();
  const preview = page.locator('[data-file-preview="markdown"]');
  const drawn = preview.locator("[data-file-markdown]");
  await expect(drawn.getByRole("heading", { level: 1, name: "Iris flowers" })).toBeVisible();
  await expect(drawn.getByRole("heading", { level: 2, name: "Columns" })).toBeVisible();
  await expect(drawn.locator('[data-streamdown="strong"]')).toHaveText("150 flowers");
  await expect(drawn.locator('[data-streamdown="strong"]')).toHaveCSS("font-weight", "600");
  // A list is marked as one.
  await expect(drawn.getByRole("listitem")).toHaveCount(2);
  await expect(drawn.getByRole("list")).toHaveCSS("list-style-type", "disc");
  // A page's table stands whole: its last row is on the page without scrolling inside the table.
  await expect(drawn.getByRole("table")).toContainText("setosa 14");
  const table = drawn.locator('[data-streamdown="table"]');
  expect(await table.evaluate(t => (t.parentElement as HTMLElement).scrollHeight - (t.parentElement as HTMLElement).clientHeight)).toBeLessThanOrEqual(1);
  for (const sign of ["# Iris", "**", "|---|", "- `"]) await expect(drawn).not.toContainText(sign);
  await expect(preview.locator('[data-file-view="preview"]')).toHaveAttribute("aria-pressed", "true");
  await expect(preview.locator("[data-file-text]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/file-readme.png" });

  // Its source, as it is written.
  await preview.locator('[data-file-view="source"]').click();
  await expect(preview.locator('[data-file-view="source"]')).toHaveAttribute("aria-pressed", "true");
  expect(await preview.locator("[data-file-text]").textContent()).toBe(README);
  await expect(drawn).toHaveCount(0);
  await page.screenshot({ path: "test-results/file-readme-source.png" });

  // Other text reads as written, and has nothing to switch.
  await page.locator('[data-file="codebook.json"]').click();
  const text = page.locator('[data-file-preview="text"]');
  expect(await text.locator("[data-file-text]").textContent()).toBe(CODEBOOK);
  await expect(text.locator("[data-file-view]")).toHaveCount(0);

  // Back on the README, it is the page again: the source is asked for one look at a time.
  await page.locator('[data-file="README.md"]').click();
  await expect(drawn.getByRole("heading", { level: 1, name: "Iris flowers" })).toBeVisible();

  // What is not text has no preview, and says so.
  await page.locator('[data-file="scan.bin"]').click();
  await expect(page.locator('[data-file-preview="none"]')).toContainText("No preview for this kind of file.");
});

test("a version with no table opens on its README, drawn", async ({ page, request }) => {
  const alice = await api(request);
  const rid = await datasetWith(alice, `scans with a readme ${Date.now()}`, [
    ["a-scan.bin", Buffer.from([0, 159, 146, 150, 255]), "application/octet-stream"],
    ["readme.md", README, "text/markdown"],
  ]);
  await signIn(page);
  await page.goto(`/datasets/${rid}`);
  await expect(page.locator('[data-file-preview="markdown"] [data-file-markdown]').getByRole("heading", { level: 1, name: "Iris flowers" })).toBeVisible();
});
