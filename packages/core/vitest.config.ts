import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["../schema/test/quiet-sqlite-warning.ts"] },
});
