import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1, D1Result } from "@packserver/ports";

const MIGRATIONS = join(import.meta.dirname, "../../schema/migrations");

/** The registry schema in an in-memory SQLite, behind the D1 port: the same SQL the Workers run. */
export function migratedD1(): { d1: D1; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  const run = (sql: string, params: unknown[] = []): D1Result => {
    const statement = db.prepare(sql);
    if (statement.columns().length > 0) return { rows: statement.all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>, meta: { changes: 0, last_row_id: null } };
    const result = statement.run(...(params as SQLInputValue[]));
    return { rows: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  };
  const d1: D1 = {
    async query(sql, params) {
      return run(sql, params);
    },
    async batch(statements) {
      db.exec("begin");
      try {
        const results = statements.map((s) => run(s.sql, s.params));
        db.exec("commit");
        return results;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  };
  return { d1, db };
}
