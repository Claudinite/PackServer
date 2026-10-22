import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/index.ts",
  out: process.env.DRIZZLE_OUT ?? "./migrations",
  migrations: { prefix: "timestamp" },
});
