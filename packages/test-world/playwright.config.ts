import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test-browser",
  timeout: 60_000,
  retries: 0,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
