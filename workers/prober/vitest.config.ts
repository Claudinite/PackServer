import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["../../packages/schema/test/quiet-sqlite-warning.ts"] },
});
