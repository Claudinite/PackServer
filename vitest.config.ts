import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "scenarios",
          include: ["scenarios/**/*.scenario.ts"],
          pool: "forks",
          testTimeout: 30_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
