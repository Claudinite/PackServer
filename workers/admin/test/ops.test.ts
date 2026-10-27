import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryAuditBucket } from "@packserver/core/audit/testing";
import { FLAG_DEFS, LAUNCH_MIRROR_KEY, writeFlag } from "@packserver/core/flags";
import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, type FakeKV, type FakeQueue } from "@packserver/ports/fakes";
import { ADMIN_METHOD_NAMES, ADMIN_METHODS, AdminResponse, type AdminRequest } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AdminRuntime } from "../src/bindings";
import { flagMirror } from "../src/flags/mirror";

const AUDIENCE = "aud-1";
const PROTECTED = "admin.example.test";
const INTERNAL = "admin.internal";
const ADMIN = "boss@example.test";
const AT = "2026-10-26T12:00:00.000Z";
const FLAG_KEY = "flag-key";

function fixture(o: { rollbackUrl?: string } = {}) {
  const fakes = createFakePorts({ worker: "admin" });
  const { d1, db } = migratedD1();
  const runtime: AdminRuntime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: {
      ...fakes,
      d1,
      auditBucket: new MemoryAuditBucket(),
      r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! },
      flagKey: async () => FLAG_KEY,
      ...(o.rollbackUrl ? { rollbackUrl: o.rollbackUrl } : {}),
    },
    services: {},
    config: { siteOrigin: "https://registry.test.invalid", access: { audience: AUDIENCE, identities: [ADMIN], hosts: [PROTECTED] } },
  };
  const exp = Math.floor(fakes.clock.now() / 1000) + 3600;
  const assertion = () => fakes.access.assert({ email: ADMIN, sub: "s1", aud: [AUDIENCE], exp });
  const app = createApp(runtime);
  const seed = (sql: string) => db.exec(sql);
  seed(`insert into users (id, handle, created_at) values ('u1', 'u1', '${AT}')`);
  seed(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'acme', 'org', 'active', '${AT}')`);
  seed(`insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's1', 'gcp', 'public', '${AT}')`);
  for (const v of ["1.0.0", "1.1.0"]) {
    seed(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v-${v}', 'p1', '${v}', 'active', '${"0".repeat(64)}', 1, '${AT}', 0, 0)`);
  }
  const stateOf = (version: string) => db.prepare("select state, status_reason, status_security from pack_versions where version = ?").get(version) as { state: string; status_reason: string | null; status_security: string | null };

  /** A service-binding call to the internal API. */
  async function call(caller: string | null, request: unknown, o: { assertion?: boolean; host?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (caller) headers["x-packserver-caller"] = caller;
    if (o.assertion) headers["cf-access-jwt-assertion"] = await assertion();
    const res = await app.request(`https://${o.host ?? INTERNAL}/internal/call`, { method: "POST", headers, body: JSON.stringify(request) });
    return { status: res.status, body: res.status === 404 ? null : AdminResponse.parse(await res.json()) };
  }
  /** A request to the admin app behind the Access guard. */
  async function admin(method: string, path: string, body?: unknown) {
    return app.request(`https://${PROTECTED}${path}`, {
      method,
      headers: { "cf-access-jwt-assertion": await assertion(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const audits = () => db.prepare("select actor_kind, actor_id, target, detail from recent_activity where action = 'admin.action' order by at, id").all() as Array<{ actor_kind: string; actor_id: string; target: string; detail: string }>;
  return { fakes, runtime, app, db, d1, call, admin, stateOf, audits, kv: fakes.kv["TELEMETRY_KV"] as FakeKV, reindex: fakes.queues["REINDEX_QUEUE"] as FakeQueue };
}

const quarantine = { method: "quarantine_version", pack: "@acme/gcp", version: "1.0.0", reason: "token leak" } as const;

describe("internal API method sets (REQ-ADMIN-010)", () => {
  it("lets the judge make its four calls and audits each as the judge", async () => {
    const f = fixture();
    const calls: AdminRequest[] = [quarantine, { method: "enable_new_pack_kill_switch", reason: "flood" }, { method: "set_telemetry_mode", mode: "economy" }, { method: "acknowledge_page", page: "page.index_stale" }];
    for (const request of calls) expect(await f.call("judge", request), request.method).toMatchObject({ status: 200, body: { ok: true } });
    expect(f.stateOf("1.0.0")).toMatchObject({ state: "quarantined", status_reason: "token leak" });
    expect(await f.kv.get("telemetry_mode")).toBe("economy");
    expect(f.audits().map((a) => [a.actor_kind, a.actor_id, JSON.parse(a.detail).verb]).sort()).toEqual([
      ["system", "judge", "ops.kill_switch.on"], ["system", "judge", "ops.page.acknowledge"], ["system", "judge", "ops.telemetry_mode"], ["system", "judge", "version.quarantine"],
    ]);
  });

  it("refuses the judge every other method, with or without an assertion, and changes nothing", async () => {
    const f = fixture();
    await f.call("judge", quarantine);
    const others = ADMIN_METHOD_NAMES.filter((m) => !(ADMIN_METHODS[m].callers as readonly string[]).includes("judge"));
    expect(others.length).toBeGreaterThan(8);
    for (const method of others) {
      for (const assertion of [false, true]) {
        const answer = await f.call("judge", { method, reason: "x", pack: "@acme/gcp", version: "1.0.0", source: "s", flag: "launch.flag", page: "p", mode: "normal" }, { assertion });
        expect(answer, `${method} ${assertion}`).toMatchObject({ status: 403, body: { ok: false, refusal: { reason: "forbidden", message: "caller_not_permitted" } } });
      }
    }
    expect(f.stateOf("1.0.0").state).toBe("quarantined");
    const rows = f.audits().map((a) => JSON.parse(a.detail));
    expect(rows.filter((r) => r.outcome === undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === "refused").length).toBe(rows.length - 1);
  });

  it("lets a lifting method through only from the admin app with the Access assertion", async () => {
    const f = fixture();
    await f.call("judge", quarantine);
    await f.call("judge", { method: "enable_new_pack_kill_switch", reason: "flood" });
    const lifts: AdminRequest[] = [
      { method: "unquarantine_version", pack: "@acme/gcp", version: "1.0.0", reason: "false positive" },
      { method: "disable_new_pack_kill_switch", reason: "flood over" },
      { method: "unfreeze_index_regeneration", reason: "fixed" },
      { method: "turn_flag_off", flag: "launch.flag" },
      { method: "unblock_source", source: "ip:1", reason: "mistake" },
    ];
    for (const request of lifts) {
      expect(await f.call("admin_app", request, { assertion: false }), `${request.method} without`).toMatchObject({ status: 403, body: { ok: false, refusal: { message: "access_assertion_required" } } });
    }
    expect(f.stateOf("1.0.0").state).toBe("quarantined");
    await f.call("admin_app", { method: "freeze_index_regeneration", reason: "x" }, { assertion: true });
    await f.call("admin_app", { method: "block_source", source: "ip:1", reason: "stuffing" }, { assertion: true });
    for (const request of lifts) expect(await f.call("admin_app", request, { assertion: true }), `${request.method} with`).toMatchObject({ body: { ok: true } });
    expect(f.stateOf("1.0.0")).toMatchObject({ state: "active", status_reason: null });
    const lifted = f.audits().filter((a) => a.actor_id === ADMIN);
    expect(lifted.map((a) => JSON.parse(a.detail).verb).sort()).toEqual(
      ["flag.off", "ops.index_freeze.off", "ops.index_freeze.on", "ops.kill_switch.off", "ops.source.block", "ops.source.unblock", "version.unquarantine"],
    );
  });

  it("refuses an assertion that does not verify as if it were absent", async () => {
    const f = fixture();
    const headers = { "content-type": "application/json", "x-packserver-caller": "admin_app", "cf-access-jwt-assertion": `${await f.fakes.access.assert({ email: "intruder@example.test", sub: "x", aud: [AUDIENCE], exp: 9e9 })}` };
    const res = await f.app.request(`https://${INTERNAL}/internal/call`, { method: "POST", headers, body: JSON.stringify({ method: "turn_flag_off", flag: "launch.flag" }) });
    expect(res.status).toBe(403);
  });

  it("answers a request that came by the public name, and an unknown caller, without serving the API", async () => {
    const f = fixture();
    expect((await f.call("judge", quarantine, { host: PROTECTED })).status).toBe(404);
    expect(await f.call(null, quarantine)).toMatchObject({ status: 403, body: { ok: false } });
    expect(await f.call("web", quarantine)).toMatchObject({ status: 403, body: { ok: false } });
    expect(await f.call("judge", { method: "nope" })).toMatchObject({ status: 403, body: { refusal: { message: "unknown_method" } } });
    expect(await f.call("judge", { method: "quarantine_version", pack: "@acme/gcp" })).toMatchObject({ status: 400, body: { ok: false } });
    expect(f.audits().every((a) => JSON.parse(a.detail).outcome === "refused")).toBe(true);
  });

  it("refuses a target that does not exist and audits the refusal, changing nothing else", async () => {
    const f = fixture();
    expect(await f.call("judge", { ...quarantine, version: "9.9.9" })).toMatchObject({ body: { ok: false, refusal: { message: expect.stringContaining("is not a version") } } });
    expect(await f.call("admin_app", { method: "unblock_source", source: "ip:none", reason: "x" }, { assertion: true })).toMatchObject({ body: { ok: false } });
    expect(f.audits().map((a) => JSON.parse(a.detail).outcome)).toEqual(["refused", "refused"]);
  });
});

describe("ops actions", () => {
  it("quarantines idempotently, yanks, and tells the scope's index to re-sign each time the status moved", async () => {
    const f = fixture();
    await f.call("judge", quarantine);
    await f.call("judge", quarantine);
    expect(f.reindex.messages).toEqual([{ schema: 1, type: "scope.proof_changed", scope: "acme", change: "version_status_changed" }]);
    await f.call("admin_app", { method: "yank_version", pack: "@acme/gcp", version: "1.0.0", reason: "bad" }, { assertion: true });
    expect(f.stateOf("1.0.0").state).toBe("yanked");
    expect(f.reindex.messages).toHaveLength(2);
    expect(await f.call("admin_app", { method: "unquarantine_version", pack: "@acme/gcp", version: "1.0.0", reason: "x" }, { assertion: true })).toMatchObject({ body: { ok: false } });
  });

  it("writes the kill switch and the freeze as signed security flags, and reads them back", async () => {
    const f = fixture();
    await f.call("judge", { method: "enable_new_pack_kill_switch", reason: "flood" });
    await f.call("admin_app", { method: "freeze_index_regeneration", reason: "bad signature" }, { assertion: true });
    const state = await (await f.admin("GET", "/admin/ops/state")).json() as { kill_switch: boolean; index_frozen: boolean; flags: Array<{ key: string; source: string }> };
    expect(state).toMatchObject({ kill_switch: true, index_frozen: true });
    expect(state.flags.find((x) => x.key === "new_pack_kill_switch")?.source).toBe("stored");
    expect((f.db.prepare("select mac from feature_flags where key = 'new_pack_kill_switch'").get() as { mac: string }).mac).toMatch(/^[0-9a-f]{64}$/);
    // Regenerating while frozen is refused rather than quietly undoing the freeze.
    expect(await f.call("admin_app", { method: "regenerate_index" }, { assertion: true })).toMatchObject({ body: { ok: false, refusal: { message: expect.stringContaining("frozen") } } });
  });

  it("refuses a security flag when the admin-only key is not configured", async () => {
    const f = fixture();
    delete (f.runtime.ports as { flagKey?: unknown }).flagKey;
    expect(await f.call("judge", { method: "enable_new_pack_kill_switch", reason: "flood" })).toMatchObject({ body: { ok: false, refusal: { message: expect.stringContaining("flag key") } } });
  });

  it("regenerates one scope or every scope with something published", async () => {
    const f = fixture();
    await f.call("admin_app", { method: "regenerate_index", scope: "acme" }, { assertion: true });
    await f.call("admin_app", { method: "regenerate_index" }, { assertion: true });
    expect(f.reindex.messages.map((m) => (m as { scope: string }).scope)).toEqual(["acme", "acme"]);
  });

  it("turns a flag on and off, mirrors launch.flag for the judge in both states, and refuses what is not a switch", async () => {
    const f = fixture();
    expect(await f.call("admin_app", { method: "turn_flag_on", flag: "launch.flag" }, { assertion: true })).toMatchObject({ body: { ok: true } });
    expect(await f.kv.get(LAUNCH_MIRROR_KEY)).toBe("true");
    await f.call("admin_app", { method: "turn_flag_off", flag: "launch.flag" }, { assertion: true });
    expect(await f.kv.get(LAUNCH_MIRROR_KEY)).toBe("false");
    for (const flag of ["cn_min_adopt_version", "new_pack_kill_switch", "shadow.blocking"]) {
      expect(await f.call("admin_app", { method: "turn_flag_on", flag }, { assertion: true }), flag).toMatchObject({ body: { ok: false } });
    }
    expect(await f.call("admin_app", { method: "turn_flag_on", flag: "staged_publishing_declared_threshold" }, { assertion: true })).toMatchObject({ body: { ok: true } });
  });

  it("sets a flag to a value from the flags page, and refuses a wrong one", async () => {
    const f = fixture();
    expect((await f.admin("POST", "/admin/flags/cn_min_adopt_version", { value: "1.2.0" })).status).toBe(200);
    expect((await f.admin("POST", "/admin/flags/cn_min_adopt_version", { value: "soon" })).status).toBe(400);
    expect((await f.admin("POST", "/admin/flags/nope", { value: 1 })).status).toBe(404);
    const listed = (await (await f.admin("GET", "/admin/flags")).json()) as { flags: Array<{ key: string; value: unknown }> };
    expect(listed.flags.find((x) => x.key === "cn_min_adopt_version")?.value).toBe("1.2.0");
    expect(listed.flags.map((x) => x.key).sort()).toEqual(FLAG_DEFS.map((d) => d.key).sort());
    expect(f.audits().map((a) => a.target)).toEqual(['flag:cn_min_adopt_version="1.2.0"']);
  });

  it("repairs a stale launch mirror on the hourly job", async () => {
    const f = fixture();
    await writeFlag({ d1: f.d1, clock: f.fakes.clock }, "launch.flag", true, null);
    await f.kv.put(LAUNCH_MIRROR_KEY, "false");
    await flagMirror(f.runtime);
    expect(await f.kv.get(LAUNCH_MIRROR_KEY)).toBe("true");
  });

  it("writes the key explicitly even when nothing ever set the flag", async () => {
    const f = fixture();
    await flagMirror(f.runtime);
    expect(await f.kv.get(LAUNCH_MIRROR_KEY)).toBe("false");
  });

  it("blocks and unblocks a source and records an acknowledged page", async () => {
    const f = fixture();
    await f.call("admin_app", { method: "block_source", source: "ip:1", reason: "stuffing" }, { assertion: true });
    expect(f.db.prepare("select source, reason, blocked_by from blocked_sources").all()).toEqual([{ source: "ip:1", reason: "stuffing", blocked_by: ADMIN }]);
    await f.call("judge", { method: "acknowledge_page", page: "page.index_stale" });
    expect(f.db.prepare("select page, acknowledged_by from page_acknowledgements").all()).toEqual([{ page: "page.index_stale", acknowledged_by: "judge" }]);
  });
});

describe("the roll-back method", () => {
  const URL = "https://github.com/acme/registry/actions/workflows/rollback.yml";

  it("starts nothing, refuses with the link to the workflow, and sends no request to GitHub", async () => {
    const f = fixture({ rollbackUrl: URL });
    const answer = await f.call("admin_app", { method: "roll_back", reason: "bad release" }, { assertion: true });
    expect(answer.body).toMatchObject({ ok: false, refusal: { message: expect.stringContaining(URL) } });
    expect(f.audits().map((a) => JSON.parse(a.detail))).toEqual([{ verb: "roll_back", reason: expect.stringContaining(URL), outcome: "refused" }]);
  });

  it("says it is not available where the environment has no release of its own", async () => {
    const none = fixture();
    expect(await none.call("admin_app", { method: "roll_back", reason: "x" }, { assertion: true })).toMatchObject({ body: { ok: false, refusal: { message: expect.stringContaining("not available") } } });
  });
});

describe("the ops page", () => {
  it("shows the state and a tap for each action, with a script that runs only under the response's nonce", async () => {
    const f = fixture({ rollbackUrl: "https://github.com/a/b/actions/workflows/rollback.yml" });
    await f.call("judge", { method: "enable_new_pack_kill_switch", reason: "flood" });
    await f.call("admin_app", { method: "block_source", source: "ip:<script>", reason: "stuffing" }, { assertion: true });
    const res = await f.admin("GET", "/admin/ops");
    expect(res.status).toBe(200);
    const html = await res.text();
    const nonce = /<script nonce="([0-9a-f]+)"/.exec(html)?.[1];
    expect(res.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain('href="https://github.com/a/b/actions/workflows/rollback.yml"');
    for (const method of ["disable_new_pack_kill_switch", "freeze_index_regeneration", "set_telemetry_mode", "quarantine_version", "block_source", "acknowledge_page", "unblock_source"]) {
      expect(html, method).toContain(method);
    }
    expect(html).toContain("paused");
    expect(html).not.toContain("<script>");
    expect(html).toContain("ip:&lt;script&gt;");
  });

  it("is behind the Access guard like the rest of the app", async () => {
    const f = fixture();
    expect((await f.app.request(`https://${PROTECTED}/admin/ops`)).status).toBe(404);
    expect((await f.app.request(`https://${PROTECTED}/admin/ops/act`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("runs a tap as the signed-in admin and refuses a body that is not JSON", async () => {
    const f = fixture();
    expect((await f.admin("POST", "/admin/ops/act", { method: "acknowledge_page", page: "p1" })).status).toBe(200);
    expect(f.audits()[0]).toMatchObject({ actor_kind: "admin", actor_id: ADMIN });
    const form = await f.app.request(`https://${PROTECTED}/admin/ops/act`, { method: "POST", headers: { "cf-access-jwt-assertion": await f.fakes.access.assert({ email: ADMIN, sub: "s1", aud: [AUDIENCE], exp: 9e9 }), "content-type": "application/x-www-form-urlencoded" }, body: "method=acknowledge_page&page=p" });
    expect(form.status).toBe(400);
  });
});

describe("revocation (REQ-VAL-018)", () => {
  it("is the admin route's alone and needs a reason and a security reason", async () => {
    const f = fixture();
    expect((await f.admin("POST", "/admin/revocations", { pack: "@acme/gcp", version: "1.0.0", reason: "x" })).status).toBe(400);
    const done = await f.admin("POST", "/admin/revocations", { pack: "@acme/gcp", version: "1.0.0", reason: "exfiltrates tokens", security: "CVE-style: sends the token to a third party" });
    expect(done.status).toBe(200);
    expect(f.stateOf("1.0.0")).toMatchObject({ state: "revoked", status_reason: "exfiltrates tokens", status_security: "CVE-style: sends the token to a third party" });
    expect(f.audits().map((a) => JSON.parse(a.detail).verb)).toEqual(["version.revoke"]);
    // A revocation is not undone through the quarantine path.
    expect(await f.call("admin_app", { method: "unquarantine_version", pack: "@acme/gcp", version: "1.0.0", reason: "x" }, { assertion: true })).toMatchObject({ body: { ok: false } });
    expect(await f.call("judge", { ...quarantine, version: "1.0.0" })).toMatchObject({ body: { ok: false } });
    expect(f.stateOf("1.0.0").state).toBe("revoked");
  });

  it("is the only path to the revoked state: no other statement writes a version's state to it, and one route runs it", () => {
    const root = join(import.meta.dirname, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const sources = ["packages", "workers"]
      .flatMap((base) => walk(join(root, base)))
      .filter((p) => p.endsWith(".ts") && !/\.test\.ts$|\/test\/|\/test-world\//.test(p))
      .map((path) => ({ path: path.slice(root.length + 1), text: readFileSync(path, "utf8") }));
    const writers = sources.filter((s) => /(update|insert[^;]*into)\s+pack_versions/i.test(s.text)).map((s) => s.path);
    expect(writers.sort()).toEqual(["packages/core/moderation/transition.ts", "packages/core/stats/mismatch.ts", "workers/publish/src/coordinator/rebuild.ts", "workers/publish/src/coordinator/scope-coordinator.ts", "workers/validator/src/promote/promote.ts"]);
    for (const writer of writers.filter((w) => w !== "packages/core/moderation/transition.ts")) expect(sources.find((s) => s.path === writer)!.text, writer).not.toMatch(/state\s*=\s*'revoked'|state:\s*["']revoked/);
    const callers = sources.filter((s) => /transitionVersion\([^)]*"revoke"/.test(s.text)).map((s) => s.path);
    expect(callers).toEqual(["workers/admin/src/ops/index.ts"]);
  });
});
