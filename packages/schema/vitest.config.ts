import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./test/quiet-sqlite-warning.ts"] },
});
