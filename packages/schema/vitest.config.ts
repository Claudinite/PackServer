import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tests apply the migrations with node:sqlite, whose experimental notice adds nothing to a test run;
    // CI pins a Node that ships it unflagged.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
