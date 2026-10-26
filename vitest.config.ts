import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import DurationSequencer from "./packages/test-world/sequencer.ts";
import { scenarioTestOptions } from "./packages/test-world/vitest.ts";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationSequencer },
    projects: [
      {
        test: { name: "infra", include: ["infra/**/*.test.mjs", "tools/**/*.test.{mjs,ts}"] },
      },
      {
        resolve: { alias: { "@packserver/test-world": fileURLToPath(new URL("./packages/test-world/index.ts", import.meta.url)) } },
        test: {
          ...scenarioTestOptions(),
          name: "scenarios",
          include: ["scenarios/**/*.scenario.ts"],
          pool: "forks",
          testTimeout: 150_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
