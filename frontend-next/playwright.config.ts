import { defineConfig } from "@playwright/test";

// Runs against the dev stack: the gateway at http://localhost:8088 with the catalog, the agent
// runtime and `bun run dev` (vite on 5174) up. Override with TEXERA_BASE_URL.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.TEXERA_BASE_URL ?? "http://localhost:8088",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
