import { MemoryAuditBucket } from "@packserver/core/audit/testing";
import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, type FakeMail, type FakeQueue } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AdminRuntime } from "../src/bindings";

const AUDIENCE = "aud-1";
const HOST = "admin.example.test";
const ADMIN = "boss@example.test";
const AT = "2026-10-26T12:00:00.000Z";

function fixture() {
  const fakes = createFakePorts({ worker: "admin" });
  const { d1, db } = migratedD1();
  const runtime: AdminRuntime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
    services: {},
    config: { siteOrigin: "https://registry.test.invalid", access: { audience: AUDIENCE, identities: [ADMIN], hosts: [HOST] } },
  };
  const app = createApp(runtime);
  const admin = async (method: string, path: string, body?: unknown) =>
    app.request(`https://${HOST}${path}`, {
      method,
      headers: { "cf-access-jwt-assertion": await fakes.access.assert({ email: ADMIN, sub: "s1", aud: [AUDIENCE], exp: Math.floor(fakes.clock.now() / 1000) + 3600 }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  for (const [id, name, state] of [["s-holder", "acme", "held"], ["s-claimant", "rightful", "active"], ["s-handle", "acmee", "held"]] as const) {
    db.exec(`insert into scopes (id, name, kind, state, created_at) values ('${id}', '${name}', 'org', '${state}', '${AT}')`);
  }
  db.exec(`insert into scope_disputes (id, scope_id, claimant_scope_id, domain, state, held_scope, created_at) values ('d1', 's-holder', 's-claimant', 'acme.com', 'open', 1, '${AT}')`);
  const audits = () => db.prepare("select actor_id, target, detail from recent_activity where action = 'admin.action'").all() as Array<{ actor_id: string; target: string; detail: string }>;
  return { admin, db, audits, mail: fakes.mail as FakeMail, reindex: fakes.queues["REINDEX_QUEUE"] as FakeQueue };
}

describe("disputes (REQ-ADMIN-005)", () => {
  it("lists the open dispute and moves the name, auditing the decision under the admin", async () => {
    const f = fixture();
    const listed = (await (await f.admin("GET", "/admin/disputes")).json()) as { disputes: Array<{ id: string; scope: string; claimant: string; held: boolean; promoted: boolean }> };
    expect(listed.disputes).toEqual([expect.objectContaining({ id: "d1", scope: "acme", claimant: "rightful", held: true, promoted: false })]);
    const done = await f.admin("POST", "/admin/disputes/d1/decision", { decision: "reassign", holder_name: "acme-prior" });
    expect(await done.json()).toEqual({ ok: true, scope: "acme", renamedTo: "acme-prior" });
    expect(f.db.prepare("select name from scopes where id = 's-claimant'").get()).toEqual({ name: "acme" });
    expect(f.audits().map((a) => [a.actor_id, a.target, JSON.parse(a.detail).verb])).toEqual([[ADMIN, "scope:@acme", "dispute.reassign"]]);
    expect((await f.admin("POST", "/admin/disputes/d1/decision", { decision: "keep" })).status).toBe(409);
    expect((await f.admin("POST", "/admin/disputes/zzz/decision", { decision: "keep" })).status).toBe(404);
    expect((await f.admin("POST", "/admin/disputes/d1/decision", { decision: "burn" })).status).toBe(400);
  });

  it("refuses to move a name with a promoted version and leaves nothing audited", async () => {
    const f = fixture();
    f.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's-holder', 'gcp', 'public', '${AT}')`);
    f.db.exec(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v1', 'p1', '1.0.0', 'active', '${"0".repeat(64)}', 1, '${AT}', 0, 0)`);
    const refused = await f.admin("POST", "/admin/disputes/d1/decision", { decision: "reassign" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, reason: "has_promoted_versions" });
    expect(f.audits()).toEqual([]);
  });
});

describe("publishing holds on handles (REQ-ADMIN-007)", () => {
  it("lists a held handle and clears it, audited, but leaves a dispute's hold to the dispute", async () => {
    const f = fixture();
    const listed = (await (await f.admin("GET", "/admin/holds")).json()) as { holds: Array<{ scope: string }> };
    expect(listed.holds.map((h) => h.scope)).toEqual(["acmee"]);
    expect((await f.admin("POST", "/admin/scopes/acme/hold/clear")).status).toBe(409);
    expect((await f.admin("POST", "/admin/scopes/@acmee/hold/clear")).status).toBe(200);
    expect(f.db.prepare("select state from scopes where name = 'acmee'").get()).toEqual({ state: "active" });
    expect(f.audits().map((a) => [a.target, JSON.parse(a.detail).verb])).toEqual([["scope:@acmee", "hold.clear"]]);
    expect((await f.admin("POST", "/admin/scopes/acmee/hold/clear")).status).toBe(409);
    expect((await f.admin("POST", "/admin/scopes/ghost/hold/clear")).status).toBe(404);
  });
});
