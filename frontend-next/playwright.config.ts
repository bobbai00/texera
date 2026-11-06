import { defineConfig } from "@playwright/test";

// Runs against the dev stack: the gateway at http://localhost:8088 with the catalog, the agent
// runtime and `bun run dev` (vite on 5174) up. Override with TEXERA_BASE_URL.
//
// The browser is Playwright's bundled Chromium (`bunx playwright install chromium`). Where that
// build is unavailable (Playwright no longer ships one for Ubuntu 20.04, say), set
// TEXERA_E2E_BROWSER_CHANNEL=chrome to drive the installed Google Chrome instead.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  // One scenario at a time: they act as the same two people, and some change what a person
  // works in, which every page of theirs follows.
  workers: 1,
  reporter: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ? [["list"], ["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE }]] : "list",
  use: {
    baseURL: process.env.TEXERA_BASE_URL ?? "http://localhost:8088",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", channel: process.env.TEXERA_E2E_BROWSER_CHANNEL || undefined },
    },
  ],
});
