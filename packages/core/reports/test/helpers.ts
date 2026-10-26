import type { D1 } from "@packserver/ports";
import { migratedD1 } from "../../identity/testing.ts";
import type { ReportPorts } from "../ports.ts";

export const START = Date.parse("2026-10-23T00:00:00.000Z");
export const DAY = 86_400_000;

export interface Fixture {
  d1: D1;
  ports: ReportPorts;
  pack: { id: string; scope_id: string; name: string; visibility: string };
  advance(ms: number): void;
  user(handle: string, role?: string): Promise<string>;
}

/** The real schema on SQLite with one public pack `@acme/gcp` holding versions 1.0.0 to 1.0.2. */
export async function fixture(): Promise<Fixture> {
  const { d1 } = migratedD1();
  let now = START;
  let n = 0;
  const ports: ReportPorts = {
    d1,
    clock: { now: () => now },
    rng: { uuid: () => `id-${++n}`, float: () => 0.5, bytes: (len) => new Uint8Array(len) },
    siteOrigin: "https://registry.example",
  };
  const at = new Date(START).toISOString();
  await d1.batch([
    { sql: "insert into scopes (id, name, kind, state, created_at) values ('scope-acme', 'acme', 'org', 'active', ?)", params: [at] },
    { sql: "insert into packs (id, scope_id, name, visibility, created_at) values ('pack-gcp', 'scope-acme', 'gcp', 'public', ?)", params: [at] },
    ...["1.0.0", "1.0.1", "1.0.2"].map((v) => ({
      sql: "insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values (?, 'pack-gcp', ?, 'active', ?, 10, 0, 0)",
      params: [`v-${v}`, v, `sha-${v}`],
    })),
  ]);
  return {
    d1,
    ports,
    pack: { id: "pack-gcp", scope_id: "scope-acme", name: "@acme/gcp", visibility: "public" },
    advance: (ms) => {
      now += ms;
    },
    async user(handle, role) {
      const id = `user-${handle}`;
      await d1.batch([
        { sql: "insert into users (id, handle, created_at) values (?, ?, ?)", params: [id, handle, at] },
        { sql: "insert into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)", params: [id, `${handle}@example.test`, at] },
        ...(role ? [{ sql: "insert into scope_members (scope_id, user_id, role, created_at) values ('scope-acme', ?, ?, ?)", params: [id, role, at] }] : []),
      ]);
      return id;
    },
  };
}

export const bug = (over: Record<string, unknown> = {}) =>
  ({ kind: "bug", version: "1.0.1", type: "crash", severity: "high", title: "Guard blocks git push", repro: "Run git push", environment: "cn 1.61004.1", attachment_ids: [], ...over }) as never;

export const security = (over: Record<string, unknown> = {}) =>
  ({ kind: "security", version: "1.0.1", severity: "high", title: "Token leaks to logs", repro: "Run with debug", environment: "cn 1.61004.1", attachment_ids: [], ...over }) as never;
