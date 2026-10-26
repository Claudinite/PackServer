import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { D1 } from "@packserver/ports";
import { migratedD1 } from "../../identity/testing.ts";
import {
  entersHumanQueue, expireSyntheticVersions, looksLikeTestSecret, ProductionConfigError, provisionCanaryScope, provisionProbeTenant, publicScopeOnly, refuseTestSecret, screensProse,
  SYNTHETIC_VERSION_TTL_MS,
} from "../index.ts";

const T0 = Date.UTC(2026, 9, 26, 12);
const HOUR = 3_600_000;
const REPO = { slug: "Claudinite/packserver-probe", id: "9001", ownerId: "42" };
const iso = (ms: number) => new Date(ms).toISOString();

async function publish(d1: D1, scope: { id: string; name: string }, pack: string, version: string, at: number, synthetic: boolean) {
  const packId = `pack-${scope.name}-${pack}`;
  await d1.query(`insert or ignore into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, 'public', 'x')`, [packId, scope.id, pack]);
  await d1.query(
    `insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, ?, ?, 'active', ?, 1, ?, 0, 0)`,
    [`v-${scope.name}-${pack}-${version}-${at}`, packId, version, "a".repeat(64), iso(at)],
  );
  await d1.query(
    `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, start_after, created_at, updated_at, expires_at)
     values (?, 'publish', 'oidc', ?, ?, ?, 'scope:x', ?, ?, ?, 1, ?, 'finished', ?, ?, ?, ?)`,
    [`run-${scope.name}-${pack}-${version}-${at}`, scope.id, pack, version, `cred-${at}-${pack}`, `staging/${at}/${pack}`, "a".repeat(64), synthetic ? 1 : 0, iso(at), iso(at), iso(at), synthetic ? iso(at + SYNTHETIC_VERSION_TTL_MS) : null],
  );
}

describe("REQ-OPS-001: the synthetic tenant", () => {
  it("is provisioned once, as a synthetic scope whose one registered publisher is the probe repository's workflow for @probe/p", async () => {
    const { d1 } = migratedD1();
    const first = await provisionProbeTenant(d1, { repository: REPO, nowMs: T0 });
    expect(first.created).toEqual({ scope: true, registration: true });
    expect((await d1.query(`select name, kind, state from scopes`)).rows).toEqual([{ name: "probe", kind: "synthetic", state: "active" }]);
    const rows = (await d1.query(`select pack_name, repository_id, repository_owner_id, repository, workflow, environment, refs, events, pending_until from trusted_publishers`)).rows;
    expect(rows).toEqual([
      {
        pack_name: "p", repository_id: "9001", repository_owner_id: "42", repository: "Claudinite/packserver-probe", workflow: ".github/workflows/probe-dry-run.yml", environment: null,
        refs: JSON.stringify(["refs/heads/main"]), events: JSON.stringify(["schedule", "workflow_dispatch"]), pending_until: null,
      },
    ]);

    const again = await provisionProbeTenant(d1, { repository: REPO, nowMs: T0 + HOUR });
    expect(again).toMatchObject({ scopeId: first.scopeId, registrationId: first.registrationId, created: { scope: false, registration: false } });
    expect((await d1.query(`select count(*) as n from trusted_publishers`)).rows).toEqual([{ n: 1 }]);
    expect((await d1.query(`select updated_at from trusted_publishers`)).rows).toEqual([{ updated_at: iso(T0) }]);
  });

  it("follows the probe repository when its ids change, and registers nothing else", async () => {
    const { d1 } = migratedD1();
    await provisionProbeTenant(d1, { repository: REPO, nowMs: T0 });
    await provisionProbeTenant(d1, { repository: { slug: "Claudinite/probe-moved", id: "9002", ownerId: "43" }, nowMs: T0 + HOUR });
    expect((await d1.query(`select pack_name, repository_id, repository_owner_id, repository, updated_at from trusted_publishers`)).rows).toEqual([
      { pack_name: "p", repository_id: "9002", repository_owner_id: "43", repository: "Claudinite/probe-moved", updated_at: iso(T0 + HOUR) },
    ]);
  });

  it("will not take over a probe scope of another kind, or name the repository by anything but its ids", async () => {
    const { d1 } = migratedD1();
    await d1.query(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'probe', 'org', 'active', 'x')`);
    await expect(provisionProbeTenant(d1, { repository: REPO, nowMs: T0 })).rejects.toThrow(/will not be taken over/);
    expect((await d1.query(`select count(*) as n from trusted_publishers`)).rows).toEqual([{ n: 0 }]);
    const fresh = migratedD1().d1;
    await expect(provisionProbeTenant(fresh, { repository: { ...REPO, id: "packserver-probe" }, nowMs: T0 })).rejects.toThrow(/numeric ids/);
  });

  it("creates the reserved @packserver-canary org for its owner, once, and will not take over one it did not create", async () => {
    const { d1 } = migratedD1();
    await d1.query(`insert into users (id, handle, created_at) values ('u1', 'ariel', 'x')`);
    const first = await provisionCanaryScope(d1, { ownerUserId: "u1", nowMs: T0 });
    expect(first.created).toBe(true);
    expect((await d1.query(`select name, kind, state from scopes`)).rows).toEqual([{ name: "packserver-canary", kind: "org", state: "active" }]);
    expect((await d1.query(`select user_id, role from scope_members`)).rows).toEqual([{ user_id: "u1", role: "owner" }]);

    expect(await provisionCanaryScope(d1, { ownerUserId: "u1", nowMs: T0 + HOUR })).toEqual({ scopeId: first.scopeId, created: false });
    expect((await d1.query(`select count(*) as n from scope_members`)).rows).toEqual([{ n: 1 }]);

    await d1.query(`insert into users (id, handle, created_at) values ('u2', 'bob', 'x')`);
    await expect(provisionCanaryScope(d1, { ownerUserId: "u2", nowMs: T0 + 2 * HOUR })).rejects.toThrow(/second owner/);
    expect((await d1.query(`select user_id from scope_members`)).rows).toEqual([{ user_id: "u1" }]);

    const other = migratedD1().d1;
    await other.query(`insert into users (id, handle, created_at) values ('u1', 'ariel', 'x')`);
    await other.query(`insert into scopes (id, name, kind, state, created_at) values ('s9', 'packserver-canary', 'org', 'active', 'x')`);
    await expect(provisionCanaryScope(other, { ownerUserId: "u1", nowMs: T0 })).rejects.toThrow(/will not be taken over/);
  });

  it("gives public listings a scope filter that leaves the tenant out", async () => {
    const { d1 } = migratedD1();
    await provisionProbeTenant(d1, { repository: REPO, nowMs: T0 });
    await d1.query(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'acme', 'org', 'active', 'x')`);
    expect((await d1.query(`select s.name from scopes s where ${publicScopeOnly("s")}`)).rows).toEqual([{ name: "acme" }]);
  });

  it("skips the prose screen and the human queue for a synthetic run only", () => {
    for (const synthetic of [true, 1] as const) expect([screensProse({ synthetic }), entersHumanQueue({ synthetic })]).toEqual([false, false]);
    for (const synthetic of [false, 0] as const) expect([screensProse({ synthetic }), entersHumanQueue({ synthetic })]).toEqual([true, true]);
  });
});

describe("REQ-OPS-001: expiry", () => {
  async function tenants() {
    const { d1 } = migratedD1();
    const probe = await provisionProbeTenant(d1, { repository: REPO, nowMs: T0 });
    await d1.query(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'acme', 'org', 'active', 'x')`);
    return { d1, probe: { id: probe.scopeId, name: "probe" }, acme: { id: "s1", name: "acme" } };
  }
  const versions = async (d1: D1) =>
    (await d1.query(`select s.name || '/' || p.name || '@' || v.version as v from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id order by 1`)).rows.map((r) => r.v);

  it("removes a synthetic version when its 24 hours are up, not a minute before, and keeps the pack", async () => {
    const { d1, probe } = await tenants();
    await publish(d1, probe, "p", "1.0.0", T0, true);
    expect(await expireSyntheticVersions(d1, T0 + SYNTHETIC_VERSION_TTL_MS - 1)).toEqual({ versions: [] });
    expect(await versions(d1)).toEqual(["probe/p@1.0.0"]);
    expect(await expireSyntheticVersions(d1, T0 + SYNTHETIC_VERSION_TTL_MS)).toEqual({ versions: ["@probe/p@1.0.0"] });
    expect(await versions(d1)).toEqual([]);
    expect((await d1.query(`select name from packs`)).rows).toEqual([{ name: "p" }]);
    expect((await d1.query(`select count(*) as n from retired_names`)).rows).toEqual([{ n: 0 }]);
    expect(await expireSyntheticVersions(d1, T0 + 2 * SYNTHETIC_VERSION_TTL_MS)).toEqual({ versions: [] });
  });

  it("leaves a version published again under the old name until its own day is up", async () => {
    const { d1, probe } = await tenants();
    await publish(d1, probe, "p", "1.0.0", T0, true);
    await expireSyntheticVersions(d1, T0 + SYNTHETIC_VERSION_TTL_MS);
    const again = T0 + SYNTHETIC_VERSION_TTL_MS + HOUR;
    await publish(d1, probe, "p", "1.0.0", again, true);
    expect(await expireSyntheticVersions(d1, again + HOUR)).toEqual({ versions: [] });
    expect(await versions(d1)).toEqual(["probe/p@1.0.0"]);
    expect(await expireSyntheticVersions(d1, again + SYNTHETIC_VERSION_TTL_MS)).toEqual({ versions: ["@probe/p@1.0.0"] });
  });

  it("never touches an ordinary scope, however old", async () => {
    const { d1, acme } = await tenants();
    await publish(d1, acme, "gcp", "1.0.0", T0, false);
    expect(await expireSyntheticVersions(d1, T0 + 365 * 24 * HOUR)).toEqual({ versions: [] });
    expect(await versions(d1)).toEqual(["acme/gcp@1.0.0"]);
  });
});

describe("REQ-OPS-003: test secrets", () => {
  const STAND_INS = ["whsec_test_00000000000000000000000000000000", "test-webhook-secret", "fake_secret", "my.dummy.value", "1x0000000000000000000000000000000AA", "", "x".repeat(32)];
  const REAL = ["9f2c41d07be34a1c8e5d62f0a7b3c918", "whsec_Zk3rQp8LwT1mVnY7cXb2HdJf5GsA0eUi", "Contest0Ranger+latest/hkq9"];

  it("reads a stand-in as one and a real secret as none", () => {
    expect(STAND_INS.map(looksLikeTestSecret)).toEqual(STAND_INS.map(() => true));
    expect(REAL.map(looksLikeTestSecret)).toEqual(REAL.map(() => false));
  });

  it("recognises every secret-shaped string IT-OPS-003 greps bundles for", async () => {
    const { TEST_STRINGS } = (await import(pathToFileURL(join(import.meta.dirname, "../../../../tools/test-strings.mjs")).href)) as { TEST_STRINGS: string[] };
    const secrets = TEST_STRINGS.filter((s) => s.startsWith("whsec_") || s.startsWith("1x"));
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(looksLikeTestSecret(secret)).toBe(true);
  });

  it("refuses a stand-in everywhere but the test environment, naming the binding and never the value", () => {
    for (const environment of ["staging", "production"]) {
      expect(() => refuseTestSecret(environment, "GITHUB_WEBHOOK_SECRET", STAND_INS[0]!)).toThrow(ProductionConfigError);
      expect(refuseTestSecret(environment, "GITHUB_WEBHOOK_SECRET", REAL[0]!)).toBe(REAL[0]);
    }
    expect(refuseTestSecret("test", "GITHUB_WEBHOOK_SECRET", STAND_INS[0]!)).toBe(STAND_INS[0]);
    expect(() => refuseTestSecret("production", "GITHUB_WEBHOOK_SECRET", STAND_INS[0]!)).toThrow("GITHUB_WEBHOOK_SECRET holds a value that only the test environment may hold");
  });
});
