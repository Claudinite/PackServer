import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1, D1Result } from "@packserver/ports";
import type { AuditBucket } from "./bucket";

// node:sqlite prints one experimental-feature notice per worker when first loaded; only that notice is dropped,
// so the module is loaded after the filter is in place.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.startsWith("SQLite is an experimental feature")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/** An in-memory stand-in for the audit bucket's S3 surface. */
export class MemoryAuditBucket implements AuditBucket {
  readonly objects = new Map<string, string>();
  /** Set to make every call fail, as an R2 outage would. */
  down = false;
  private check() {
    if (this.down) throw new Error("audit bucket unavailable");
  }
  async get(key: string) {
    this.check();
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: string) {
    this.check();
    this.objects.set(key, body);
  }
  async list(prefix: string, limit: number) {
    this.check();
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
  }
  /** Batch objects in chain order. */
  batchKeys(): string[] {
    return [...this.objects.keys()].filter((k) => k.endsWith(".ndjson")).sort();
  }
  /** Flips one byte of a stored object, the edit the verifier must catch. */
  tamper(key: string, offset = 0): void {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`no such object: ${key}`);
    const at = Math.min(offset, body.length - 1);
    this.objects.set(key, body.slice(0, at) + String.fromCharCode(body.charCodeAt(at) ^ 1) + body.slice(at + 1));
  }
  /** Every stored byte as one string, for the no-raw-secrets scans. */
  everything(): string {
    return [...this.objects.values()].join("\n");
  }
}

const MIGRATIONS = join(import.meta.dirname, "../../schema/migrations");

/** The real schema on SQLite behind the D1 port, with a switch for an outage. */
export class SqliteD1 implements D1 {
  readonly db = new DatabaseSync(":memory:");
  down = false;
  constructor() {
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
    }
  }
  async query(sql: string, params: unknown[] = []): Promise<D1Result> {
    if (this.down) throw new Error("D1 unavailable");
    const stmt = this.db.prepare(sql);
    const args = params as Array<string | number | null>;
    if (/^\s*select/i.test(sql)) return { rows: stmt.all(...args) as Array<Record<string, unknown>>, meta: { changes: 0, last_row_id: null } };
    const r = stmt.run(...args);
    return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
    const out: D1Result[] = [];
    for (const s of statements) out.push(await this.query(s.sql, s.params));
    return out;
  }
  rows(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<Record<string, unknown>>;
  }
}
