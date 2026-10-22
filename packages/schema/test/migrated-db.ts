import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

/** An in-memory SQLite with every migration applied in name order, foreign keys enforced as D1 does. */
export function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}
