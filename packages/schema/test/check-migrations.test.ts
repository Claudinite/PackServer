import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TOOL = join(import.meta.dirname, "../../../tools/check-migrations.mjs");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(files: Record<string, string>): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  try {
    execFileSync("node", [TOOL, dir], { stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String((e as { stderr: Buffer }).stderr) };
  }
}

const FOUNDATION = "20260101000000_foundation_tables.sql";
const base = { [FOUNDATION]: "CREATE TABLE users (id text PRIMARY KEY);\nCREATE TABLE packs (id text PRIMARY KEY);" };

describe("check-migrations", () => {
  it("accepts an area that references foundation tables and its own earlier files", () => {
    const r = run({
      ...base,
      "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text, user_id text REFERENCES users(id));",
      "20260103000000_tokens_index.sql": "CREATE INDEX tokens_user ON tokens (user_id);",
    });
    expect(r).toEqual({ ok: true, out: "" });
  });

  it("rejects two files with the same timestamp prefix", () => {
    const r = run({ ...base, "20260101000000_tokens_create.sql": "CREATE TABLE tokens (id text);" });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/same timestamp prefix/);
  });

  it("rejects a reference to a table of another area", () => {
    const r = run({
      ...base,
      "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text);",
      "20260103000000_audit_create.sql": "CREATE TABLE audit (token_id text REFERENCES tokens(id));",
    });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/cross-area/);
  });

  it("rejects a reference to a table no earlier migration created", () => {
    const r = run({ ...base, "20260102000000_audit_create.sql": "CREATE TABLE audit (x text REFERENCES ghosts(id));" });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/no earlier migration created/);
  });

  it("rejects a reference to a table created by a later file", () => {
    const r = run({
      [FOUNDATION]: "CREATE TABLE users (id text REFERENCES tokens(id));",
      "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text);",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed file name", () => {
    expect(run({ ...base, "0002_tokens.sql": "select 1;" }).ok).toBe(false);
  });

  it.each([
    ["DROP TABLE", "DROP TABLE packs;"],
    ["DROP COLUMN", "ALTER TABLE packs DROP COLUMN id;"],
    ["RENAME", "ALTER TABLE packs RENAME TO packs2;"],
    ["NOT NULL", "ALTER TABLE packs ADD COLUMN extra text NOT NULL;"],
  ])("rejects %s without a contract marker", (_label, sql) => {
    const r = run({ ...base, "20260102000000_tokens_change.sql": sql });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/contract-of/);
  });

  it("accepts a NOT NULL column that has a default", () => {
    expect(run({ ...base, "20260102000000_tokens_change.sql": "ALTER TABLE packs ADD COLUMN extra text NOT NULL DEFAULT 'x';" }).ok).toBe(true);
  });

  it("accepts a contract naming an earlier expand and rejects one naming a missing file", () => {
    const expand = { "20260102000000_packs_expand.sql": "ALTER TABLE packs ADD COLUMN slug text;" };
    expect(run({ ...base, ...expand, "20260103000000_packs_contract.sql": `-- contract-of: 20260102000000_packs_expand.sql\nALTER TABLE packs DROP COLUMN id;` }).ok).toBe(true);
    expect(run({ ...base, ...expand, "20260103000000_packs_contract.sql": `-- contract-of: 20260101999999_packs_expand.sql\nALTER TABLE packs DROP COLUMN id;` }).ok).toBe(false);
  });

  it("rejects a contract marker on a migration that is safe", () => {
    const r = run({ ...base, "20260102000000_packs_expand.sql": "-- contract-of: 20260101000000_foundation_tables.sql\nALTER TABLE packs ADD COLUMN slug text;" });
    expect(r.ok).toBe(false);
  });

  it("passes on the repository's own migrations", () => {
    expect(() => execFileSync("node", [TOOL], { stdio: "pipe" })).not.toThrow();
  });
});
