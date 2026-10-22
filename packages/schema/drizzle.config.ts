import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/index.ts",
  out: "./migrations",
  migrations: { prefix: "timestamp" },
});
