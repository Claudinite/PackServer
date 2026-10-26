import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../../test/migrated-db";

const MIGRATION = "20261026221123_foundation_scopes_kind_synthetic.sql";

/** Every migration before the one that adds the synthetic kind, with rows in the tables that reference scopes. */
function beforeKind(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().filter((f) => f < MIGRATION)) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8").replaceAll("--> statement-breakpoint", ""));
  return db;
}

describe("the synthetic scope kind", () => {
  it("is added to a database that already holds scopes, packs and members, and keeps every row", () => {
    const db = beforeKind();
    const now = "2026-10-26T00:00:00.000Z";
    db.exec(`insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '${now}')`);
    db.exec(`insert into users (id, created_at) values ('u1', '${now}')`);
    db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'u1', 'owner', '${now}')`);
    expect(() => db.exec(`insert into scopes (id, name, kind, created_at) values ('s2', 'probe', 'synthetic', '${now}')`)).toThrow(/CHECK/);

    db.exec("begin");
    db.exec(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8").replaceAll("--> statement-breakpoint", ""));
    db.exec("commit");

    expect(db.prepare("select id, name, kind, state from scopes").all()).toEqual([{ id: "s1", name: "acme", kind: "org", state: "active" }]);
    expect(db.prepare("select count(*) as n from scope_members").get()).toEqual({ n: 1 });
    expect(db.prepare("pragma foreign_key_check").all()).toEqual([]);
    db.exec(`insert into scopes (id, name, kind, created_at) values ('s2', 'probe', 'synthetic', '${now}')`);
    expect(() => db.exec(`insert into scopes (id, name, kind, created_at) values ('s3', 'x', 'other', '${now}')`)).toThrow(/CHECK/);
    expect(() => db.exec(`insert into scopes (id, name, kind, created_at) values ('s4', 'acme', 'org', '${now}')`)).toThrow(/UNIQUE/);
    expect(db.prepare("select name from sqlite_master where name like 'scopes_before%'").all()).toEqual([]);
  });
});
