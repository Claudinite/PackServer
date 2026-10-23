import { defineConfig } from "vitest/config";
import { scenarioTestOptions } from "./vitest.ts";

export default defineConfig({
  test: { ...scenarioTestOptions(), include: ["test/**/*.test.ts"], pool: "forks", testTimeout: 30_000, hookTimeout: 120_000 },
});
