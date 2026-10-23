import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migratedDb } from "../../test/migrated-db";
import { VERSION_STATES } from "../shapes/domain";
import * as db from "./index";

const NOW = "2026-10-22T00:00:00.000Z";

function seed() {
  const d = migratedDb();
  d.exec(`insert into users (id, created_at) values ('u1', '${NOW}')`);
  d.exec(`insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '${NOW}')`);
  d.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's1', 'gcp', 'public', '${NOW}')`);
  return d;
}

const version = (id: string, v: string, state = "active") =>
  `insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified)
   values ('${id}', 'p1', '${v}', '${state}', '${"a".repeat(64)}', 10, 0, 0)`;

describe("foundation tables", () => {
  const tables = (Object.values(db) as unknown[]).filter((x): x is Table => is(x, Table));

  it("declares exactly the foundation tables and each later area's", () => {
    expect(tables.map(getTableName).sort()).toEqual(
      ["credentials", "feature_flags", "identities", "pack_versions", "packs", "recent_activity", "retired_names", "scope_members", "scopes", "session_revocations", "trusted_publishers", "upload_credentials", "users"],
    );
  });

  it("matches the migrated database column for column", () => {
    const d = migratedDb();
    for (const table of tables) {
      const live = (d.prepare(`pragma table_info(${getTableName(table)})`).all() as { name: string }[]).map((c) => c.name).sort();
      const declared = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(live, getTableName(table)).toEqual(declared);
    }
  });

  it("IT-PUB-017: a version of a pack exists once", () => {
    const d = seed();
    d.exec(version("v1", "1.0.0"));
    expect(() => d.exec(version("v2", "1.0.0"))).toThrow(/UNIQUE/);
    d.exec(version("v3", "1.0.1"));
  });

  it("IT-SCOPE-012: a retired scope, pack or version name is recorded once per kind", () => {
    const d = seed();
    const retire = (kind: string, name: string) => `insert into retired_names (kind, name, retired_at) values ('${kind}', '${name}', '${NOW}')`;
    d.exec(retire("scope", "gone"));
    d.exec(retire("pack", "@p/old"));
    d.exec(retire("version", "@p/gcp@1.0.0"));
    expect(() => d.exec(retire("scope", "gone"))).toThrow(/UNIQUE/);
    expect(() => d.exec(retire("other", "x"))).toThrow(/CHECK/);
  });

  it("limits a version's state to the shared state enum", () => {
    const d = seed();
    for (const [i, state] of VERSION_STATES.entries()) d.exec(version(`v${i}`, `1.0.${i}`, state));
    expect(() => d.exec(version("bad", "2.0.0", "published"))).toThrow(/CHECK/);
  });

  it("holds a score only between 0 and 100", () => {
    const d = seed();
    d.exec(version("v1", "1.0.0"));
    expect(() => d.exec("update pack_versions set score = 101")).toThrow(/CHECK/);
    d.exec("update pack_versions set score = 100");
  });

  it("enforces foreign keys and unique scope names", () => {
    const d = seed();
    expect(() => d.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p2', 'nope', 'x', 'public', '${NOW}')`)).toThrow(/FOREIGN KEY/);
    expect(() => d.exec(`insert into scopes (id, name, kind, created_at) values ('s2', 'acme', 'user', '${NOW}')`)).toThrow(/UNIQUE/);
  });
});
