import { parseAuditEvents, auditCursor, pageCategory, type ReleaseRecord } from "@packserver/core/gates";
import { describe, expect, it } from "vitest";
import { cloudflareAuditLog, MAX_AUDIT_PAGES, pollAccountAudit, type AuditLog, type AuditPageRequest } from "../src/heartbeat/audit";
import { judgeFakes } from "./support";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const at = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString();

/** An entry in the shape of `aaa_audit-logs-v2` in cloudflare/api-schemas: the time and type are under `action`, the product under `resource`. */
function entry(id: string, offsetS: number, init: { type?: string; actor?: Record<string, unknown>; resource?: Record<string, unknown>; uri?: string }) {
  return {
    id,
    account: { id: "acct", name: "Example" },
    action: { type: init.type ?? "update", time: at(offsetS), result: "success", description: "x" },
    actor: init.actor ?? { type: "user", context: "dash", id: "u1", email: "a@b.c", ip_address: "192.0.2.1" },
    resource: init.resource ?? { id: "r", product: "members", type: "member", scope: "accounts" },
    raw: { method: "POST", uri: init.uri ?? "/accounts/acct/members", status_code: 200, cf_ray_id: "ray" },
  };
}
const ci = { type: "user", context: "api_token", id: "u9", token_id: "ci-1", token_name: "deploy" };
const script = (name: string, rest = "") => ({ resource: { id: name, product: "workers", type: "script" }, uri: `/accounts/acct/workers/scripts/${name}${rest}` });
const release = (state = "rolling"): ReleaseRecord => ({ release_id: "r1", state, workers: { web: { version_id: "web-v2", changed: true }, mcp: { version_id: "mcp-v1", changed: false } } });

/** A listing that answers oldest-first, `size` entries at a time, with `result_info.cursor` while more remain. */
function listing(all: ReturnType<typeof entry>[], size = 100): AuditLog & { requests: AuditPageRequest[] } {
  const requests: AuditPageRequest[] = [];
  return {
    requests,
    async list(request) {
      requests.push(request);
      const sorted = all.filter((e) => e.action.time >= request.since).sort((a, b) => a.action.time.localeCompare(b.action.time));
      const from = request.cursor ? Number(request.cursor) : 0;
      const page = sorted.slice(from, from + size);
      return { success: true, result: page, result_info: { count: String(page.length), ...(from + size < sorted.length ? { cursor: String(from + size) } : {}) } };
    },
  };
}

function setup(entries: ReturnType<typeof entry>[], options: { release?: ReleaseRecord | null; size?: number; maxSignals?: number } = {}) {
  const fakes = judgeFakes();
  const kv = fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  const log = listing(entries, options.size);
  const emitted: Array<{ signal: string; attrs: Record<string, unknown> }> = [];
  const run = () =>
    pollAccountAudit({
      log, kv, clock: fakes.clock,
      emit: ((signal: string, attrs: Record<string, unknown>) => emitted.push({ signal, attrs })) as never,
      release: options.release === undefined ? release() : options.release,
      ciTokenIds: ["ci-1"],
      maxSignals: options.maxSignals ?? 40,
    });
  return { fakes, kv, log, emitted, run };
}

describe("parsing the v2 listing", () => {
  it("reads the time and type from `action` and the product from `resource`", () => {
    const [e] = parseAuditEvents({ result: [entry("e1", -5, { type: "create", actor: ci, ...script("web", "/versions") })] });
    expect(e).toMatchObject({ id: "e1", at: at(-5), actionType: "create", actor: { kind: "token", tokenId: "ci-1" }, resource: { id: "web", product: "workers", type: "script" } });
    expect(e?.uri).toBe("/accounts/acct/workers/scripts/web/versions");
  });
  it("drops an entry missing its id, time or type, and reads the cursor", () => {
    expect(parseAuditEvents({ result: [{ id: "x", action: { type: "update" } }, { action: { type: "update", time: at(0) } }, "nope"] })).toEqual([]);
    expect(auditCursor({ result_info: { count: "1", cursor: "abc" } })).toBe("abc");
    expect(auditCursor({ result_info: { count: "1" } })).toBeNull();
  });
});

describe("the page list over real action types", () => {
  const category = (init: Parameters<typeof entry>[2]) => pageCategory(parseAuditEvents({ result: [entry("e", 0, init)] })[0] as never);
  it("reads the category off the product, the resource type and the path, since `update` names nothing", () => {
    expect(category({ resource: { product: "api_tokens", type: "token", id: "t" }, uri: "/user/tokens" })).toBe("token");
    expect(category({ resource: { product: "members", type: "member", id: "m" } })).toBe("member");
    expect(category({ resource: { product: "access", type: "application", id: "a" }, uri: "/accounts/acct/access/apps" })).toBe("access");
    expect(category({ resource: { product: "logpush", type: "job", id: "j" }, uri: "/accounts/acct/logpush/jobs" })).toBe("logpush");
    expect(category({ resource: { product: "r2", type: "bucket", id: "b" }, uri: "/accounts/acct/r2/buckets/b/lock" })).toBe("bucket_lock");
    expect(category({ resource: { product: "workers", type: "secret", id: "s" }, uri: "/accounts/acct/workers/scripts/web/secrets" })).toBe("secrets");
    expect(category({ ...script("web") })).toBe("worker_upload");
    expect(category({ resource: { product: "workers", type: "route", id: "r" }, uri: "/zones/z/workers/routes" })).toBe("worker_route");
    expect(category({ resource: { product: "waf", type: "ruleset", id: "r" }, uri: "/zones/z/rulesets" })).toBe("waf");
    expect(category({ type: "view", resource: { product: "members", type: "member", id: "m" } })).toBeNull();
    expect(category({ resource: { product: "dns", type: "record", id: "r" }, uri: "/zones/z/dns_records" })).toBeNull();
  });
});

describe("account audit polling", () => {
  it("pages on a page-list event by anyone but a CI token", async () => {
    const { emitted, run } = setup([entry("e1", -30, {})]);
    expect(await run()).toMatchObject({ signalled: 1, pageworthy: 1 });
    expect(emitted[0]).toMatchObject({ signal: "cloudflare.audit_event", attrs: { category: "member", actor_kind: "user", pageworthy: true, ci_token: false, entry: "e1" } });
  });

  it("accounts for a CI upload of the manifest's own version, and for nothing else it does", async () => {
    const { emitted, run } = setup([
      entry("up", -50, { type: "create", actor: ci, ...script("web", "/versions"), resource: { id: "web-v2", product: "workers", type: "script_version" } }),
      entry("other-worker", -45, { type: "create", actor: ci, ...script("mcp", "/versions"), resource: { id: "mcp-v1", product: "workers", type: "script_version" } }),
      entry("other-version", -40, { type: "create", actor: ci, ...script("web", "/versions"), resource: { id: "web-v1", product: "workers", type: "script_version" } }),
      entry("token", -30, { actor: ci, resource: { product: "api_tokens", type: "token", id: "t" }, uri: "/user/tokens" }),
      entry("stranger", -20, { type: "create", actor: { type: "user", context: "api_token", token_id: "someone-else" }, ...script("web", "/versions"), resource: { id: "web-v2", product: "workers", type: "script_version" } }),
    ]);
    await run();
    expect(emitted.map((e) => [e.attrs.entry, e.attrs.accounted_for, e.attrs.pageworthy])).toEqual([
      ["up", true, false], ["other-worker", false, true], ["other-version", false, true], ["token", false, true], ["stranger", false, true],
    ]);
  });

  it("accounts for a rollout step only while the release is rolling", async () => {
    const step = entry("dep", -10, { type: "create", actor: ci, ...script("web", "/deployments") });
    expect((await (async () => { const s = setup([step]); await s.run(); return s.emitted[0]?.attrs.accounted_for; })())).toBe(true);
    for (const state of ["verifying", "live", "finalised", "rolled_back"]) {
      const s = setup([step], { release: release(state) });
      await s.run();
      expect(s.emitted[0]?.attrs.accounted_for, state).toBe(false);
    }
  });

  it("does not account for a CI token's re-upload after the release is live", async () => {
    const { emitted, run } = setup([entry("late", -10, { type: "create", actor: ci, ...script("web", "/versions"), resource: { id: "web-v2", product: "workers", type: "script_version" } })], { release: release("live") });
    await run();
    expect(emitted[0]?.attrs).toMatchObject({ ci_token: true, accounted_for: false, pageworthy: true });
  });

  it("ignores reads and events off the page list", async () => {
    const { emitted, run } = setup([entry("a", -30, { type: "view" }), entry("b", -20, { resource: { product: "dns", type: "record", id: "r" }, uri: "/zones/z/dns_records" })]);
    expect(await run()).toMatchObject({ read: 2, signalled: 0 });
    expect(emitted).toEqual([]);
  });

  it("pages through a window of more than one page, oldest first, without losing the old ones", async () => {
    const many = Array.from({ length: 250 }, (_, i) => entry(`e${i}`, -500 + i, {}));
    const { emitted, log, run } = setup(many, { size: 100, maxSignals: 1000 });
    const poll = await run();
    expect(poll.signalled).toBe(250);
    expect(log.requests.map((r) => r.cursor)).toEqual([null, "100", "200"]);
    expect(emitted[0]?.attrs.entry).toBe("e0");
  });

  it("picks up where it stopped, repeating nothing, when the page limit or the point budget cuts a window short", async () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`e${i}`, -100 + i, {}));
    const { fakes, emitted, run } = setup(many, { maxSignals: 5 });
    expect((await run()).deferred).toBe(true);
    fakes.clock.advance("1m");
    await run();
    fakes.clock.advance("1m");
    await run();
    expect(emitted.map((e) => e.attrs.entry)).toEqual(many.map((e) => e.id));
    expect(MAX_AUDIT_PAGES).toBeGreaterThan(1);
  });

  it("starts ten minutes back, then continues from its cursor, deduping on the entry id", async () => {
    const { fakes, log, emitted, run } = setup([entry("e1", -30, {})]);
    await run();
    expect(Date.parse(log.requests[0]?.before ?? "") - Date.parse(log.requests[0]?.since ?? "")).toBe(10 * 60_000);
    fakes.clock.advance("1m");
    await run();
    expect(log.requests[1]?.since).toBe(at(-30));
    expect(emitted).toHaveLength(1);
  });
});

describe("the audit log client", () => {
  it("asks oldest first, with the cursor and the audit token", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fetchImpl = (async (url: URL, init: RequestInit) => ((seen = { url: String(url), auth: new Headers(init.headers).get("authorization") }), new Response("{}"))) as unknown as typeof fetch;
    await cloudflareAuditLog({ accountId: async () => "acct", token: async () => "tok" }, fetchImpl).list({ since: "2026-10-22T00:00:00Z", before: "2026-10-22T01:00:00Z", cursor: "c1" });
    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/client/v4/accounts/acct/logs/audit");
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: "2026-10-22T00:00:00Z", before: "2026-10-22T01:00:00Z", direction: "asc", limit: "100", cursor: "c1" });
    expect(seen?.auth).toBe("Bearer tok");
  });
});
