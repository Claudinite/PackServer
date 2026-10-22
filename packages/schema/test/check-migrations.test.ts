import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), sql);
  }
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
    const r = run({ ...base, "20260102000000_foundation_change.sql": sql });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/contract-of/);
  });

  it("accepts a NOT NULL column that has a default", () => {
    expect(run({ ...base, "20260102000000_foundation_change.sql": "ALTER TABLE packs ADD COLUMN extra text NOT NULL DEFAULT 'x';" }).ok).toBe(true);
  });

  it("accepts a contract naming an earlier expand and rejects one naming a missing file", () => {
    const expand = { "20260102000000_foundation_expand.sql": "ALTER TABLE packs ADD COLUMN slug text;" };
    expect(run({ ...base, ...expand, "20260103000000_foundation_contract.sql": `-- contract-of: 20260102000000_foundation_expand.sql\nALTER TABLE packs DROP COLUMN id;` }).ok).toBe(true);
    expect(run({ ...base, ...expand, "20260103000000_foundation_contract.sql": `-- contract-of: 20260101999999_foundation_expand.sql\nALTER TABLE packs DROP COLUMN id;` }).ok).toBe(false);
  });

  it("rejects a contract marker on a migration that is safe", () => {
    const r = run({ ...base, "20260102000000_foundation_expand.sql": "-- contract-of: 20260101000000_foundation_tables.sql\nALTER TABLE packs ADD COLUMN slug text;" });
    expect(r.ok).toBe(false);
  });

  it("accepts the NOT NULL DEFAULT order Drizzle writes", () => {
    expect(run({ ...base, "20260102000000_foundation_change.sql": "ALTER TABLE `packs` ADD `n` integer DEFAULT 0 NOT NULL;" }).ok).toBe(true);
  });

  it("counts a trigger as a reference", () => {
    const r = run({
      ...base,
      "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text);",
      "20260103000000_audit_create.sql": "CREATE TRIGGER t AFTER INSERT ON tokens BEGIN SELECT 1; END;",
    });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/cross-area/);
  });

  it.each([
    ["AFTER UPDATE ON", "CREATE TRIGGER t AFTER UPDATE ON tokens BEGIN SELECT 1; END;"],
    ["AFTER UPDATE OF col ON", "CREATE TRIGGER t AFTER UPDATE OF n ON tokens BEGIN SELECT 1; END;"],
  ])("does not read trigger keywords as tables: %s", (_label, trigger) => {
    const r = run({ ...base, "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text, n text);", "20260103000000_tokens_trigger.sql": trigger });
    expect(r).toEqual({ ok: true, out: "" });
  });

  it("rejects a non-foundation migration that alters a foundation table, and lets a later foundation file alter it", () => {
    const alter = "ALTER TABLE packs ADD COLUMN extra text;";
    expect(run({ ...base, "20260102000000_tokens_change.sql": alter }).out).toMatch(/foundation tables are altered only by foundation/);
    expect(run({ ...base, "20260102000000_foundation_more.sql": alter }).ok).toBe(true);
  });

  it.each([
    ["DROP TABLE", "DROP TABLE packs;"],
    ["RENAME", "ALTER TABLE packs RENAME TO packs_old;"],
  ])("rejects another area's %s of a foundation table even with a contract marker", (_label, statement) => {
    const files = {
      ...base,
      "20260102000000_tokens_create.sql": "CREATE TABLE tokens (id text);",
    };
    const r = run({ ...files, "20260103000000_tokens_drop.sql": `-- contract-of: 20260102000000_tokens_create.sql\n${statement}` });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/foundation tables are altered only by foundation/);
  });

  it.each([
    ["renamed onto a new name", "CREATE TABLE `__new_extra` (id text);\n--> statement-breakpoint\nALTER TABLE `__new_extra` RENAME TO `extra`;"],
    ["never renamed", "CREATE TABLE `__new_extra` (id text);"],
  ])("counts a __new_ table %s as creating a foundation table", (_label, sql) => {
    const r = run({ ...base, "20260102000000_foundation_more.sql": sql });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/first foundation/);
  });

  it("requires the contract's expand to have touched the same table", () => {
    const files = {
      ...base,
      "20260102000000_foundation_expand.sql": "ALTER TABLE packs ADD COLUMN slug text;",
      "20260103000000_foundation_other.sql": "ALTER TABLE users ADD COLUMN nick text;",
    };
    const contract = (target: string) => `-- contract-of: ${target}\nALTER TABLE packs DROP COLUMN slug;`;
    expect(run({ ...files, "20260104000000_foundation_contract.sql": contract("20260102000000_foundation_expand.sql") }).ok).toBe(true);
    const r = run({ ...files, "20260104000000_foundation_contract.sql": contract("20260103000000_foundation_other.sql") });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/did not touch packs/);
  });

  it("allows cross-area references only to users, scopes, packs and pack_versions", () => {
    const files = { [FOUNDATION]: "CREATE TABLE users (id text);\nCREATE TABLE credentials (id text);" };
    expect(run({ ...files, "20260102000000_tokens_create.sql": "CREATE TABLE a (c text REFERENCES users(id));" }).ok).toBe(true);
    const r = run({ ...files, "20260102000000_tokens_create.sql": "CREATE TABLE a (c text REFERENCES credentials(id));" });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/cross-area/);
  });

  it("lets only the first foundation migration create foundation tables", () => {
    const r = run({ ...base, "20260102000000_foundation_more.sql": "CREATE TABLE extra (id text);" });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/first foundation/);
  });

  it("names an earlier expand, not the table-creating foundation file or a contract as the contract target", () => {
    const expand = { "20260102000000_foundation_expand.sql": "ALTER TABLE packs ADD COLUMN slug text;" };
    const contract = (target: string) => `-- contract-of: ${target}\nALTER TABLE packs DROP COLUMN id;`;
    expect(run({ ...base, ...expand, "20260103000000_foundation_contract.sql": contract(FOUNDATION) }).ok).toBe(false);
    const files = { ...base, ...expand, "20260103000000_foundation_contract.sql": contract("20260102000000_foundation_expand.sql") };
    expect(run({ ...files, "20260104000000_foundation_again.sql": contract("20260103000000_foundation_contract.sql") }).ok).toBe(false);
  });

  describe("Drizzle table rebuilds", () => {
    const snapshot = (columns: string[]) => JSON.stringify({ tables: { packs: { columns: Object.fromEntries(columns.map((c) => [c, {}])) } } });
    const rebuild =
      "PRAGMA foreign_keys=OFF;\n--> statement-breakpoint\nCREATE TABLE `__new_packs` (`id` text);\n--> statement-breakpoint\n" +
      "INSERT INTO `__new_packs`(`id`) SELECT `id` FROM `packs`;\n--> statement-breakpoint\nDROP TABLE `packs`;\n--> statement-breakpoint\n" +
      "ALTER TABLE `__new_packs` RENAME TO `packs`;\n--> statement-breakpoint\nPRAGMA foreign_keys=ON;";
    const history = (after: string[]) => ({
      ...base,
      "20260101000000_foundation_tables.sql": base[FOUNDATION],
      "meta/20260101000000_snapshot.json": snapshot(["id", "name"]),
      "20260102000000_foundation_rebuild.sql": rebuild,
      "meta/20260102000000_snapshot.json": snapshot(after),
    });

    it("accepts a rebuild that keeps every column", () => {
      expect(run(history(["id", "name", "extra"])).ok).toBe(true);
    });

    it("requires a contract marker when the rebuild drops a column", () => {
      const r = run(history(["id"]));
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/DROP COLUMN packs\.name/);
    });
  });

  it("passes on the repository's own migrations", () => {
    expect(() => execFileSync("node", [TOOL], { stdio: "pipe" })).not.toThrow();
  });
});
