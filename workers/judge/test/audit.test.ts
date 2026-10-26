import { parseAuditEvents, type ReleaseRecord } from "@packserver/core/gates";
import { describe, expect, it } from "vitest";
import { MAX_AUDIT_SIGNALS, pollAccountAudit, cloudflareAuditLog } from "../src/heartbeat/audit";
import { judgeFakes } from "./support";

const at = (offsetS: number) => new Date(Date.UTC(2026, 9, 22, 12, 0, 0) + offsetS * 1000).toISOString();
const event = (offsetS: number, action: string, actor: Record<string, unknown>, resourceId = "r") => ({ action, timestamp: at(offsetS), actor, resources: [{ resource_id: resourceId, resource_type: "x" }] });
const release: ReleaseRecord = { release_id: "r1", state: "rolling", workers: { web: { version_id: "w1", changed: true }, mcp: { version_id: "m1", changed: false } } };

function setup(events: unknown[], options: { ci?: string[]; release?: ReleaseRecord | null } = {}) {
  const fakes = judgeFakes();
  const kv = fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  const calls: Array<[string, string]> = [];
  const emitted: Array<{ signal: string; attrs: Record<string, unknown> }> = [];
  const run = () =>
    pollAccountAudit({
      log: { list: async (since, before) => (calls.push([since, before]), { result: events }) },
      kv,
      clock: fakes.clock,
      emit: ((signal: string, attrs: Record<string, unknown>) => emitted.push({ signal, attrs })) as never,
      release: options.release === undefined ? release : options.release,
      ciTokenIds: options.ci ?? ["ci-1"],
    });
  return { fakes, kv, calls, emitted, run };
}

describe("account audit polling", () => {
  it("pages on a page-list event by anyone but a CI token", async () => {
    const { emitted, run } = setup([event(-30, "token.create", { type: "user", id: "u1", email: "a@b.c" })]);
    expect(await run()).toMatchObject({ signalled: 1, pageworthy: 1 });
    expect(emitted[0]).toMatchObject({ signal: "cloudflare.audit_event", attrs: { category: "token", actor_kind: "user", pageworthy: true, ci_token: false } });
  });

  it("accounts for a CI token's upload of a Worker the release changed, and for nothing else it does", async () => {
    const ci = { type: "token", id: "ci-1" };
    const { emitted, run } = setup([
      event(-50, "worker.script.upload", ci, "web"),
      event(-40, "worker.script.upload", ci, "mcp"),
      event(-30, "token.create", ci),
      event(-20, "worker.script.upload", { type: "token", id: "other" }, "web"),
    ]);
    await run();
    expect(emitted.map((e) => [e.attrs.accounted_for, e.attrs.pageworthy])).toEqual([[true, false], [false, true], [false, true], [false, true]]);
  });

  it("does not account for a CI token when no release is in flight", async () => {
    const { emitted, run } = setup([event(-30, "worker.script.upload", { type: "token", id: "ci-1" }, "web")], { release: null });
    await run();
    expect(emitted[0]?.attrs).toMatchObject({ ci_token: true, accounted_for: false, pageworthy: true });
  });

  it("ignores reads and events off the page list", async () => {
    const { emitted, run } = setup([event(-30, "token.view", { type: "user" }), event(-20, "dns.record.create", { type: "user" }), event(-10, "list.tokens", { type: "user" })]);
    expect(await run()).toMatchObject({ read: 3, signalled: 0 });
    expect(emitted).toEqual([]);
  });

  it("starts ten minutes back, then continues from its cursor without repeating an event", async () => {
    const { fakes, calls, emitted, run } = setup([event(-30, "member.add", { type: "user", id: "u" })]);
    await run();
    expect(Date.parse(calls[0]?.[1] ?? "") - Date.parse(calls[0]?.[0] ?? "")).toBe(10 * 60_000);
    fakes.clock.advance("1m");
    await run();
    expect(calls[1]?.[0]).toBe(at(-30));
    expect(emitted).toHaveLength(1);
  });

  it("leaves what is past the invocation's point budget for the next one", async () => {
    const many = Array.from({ length: MAX_AUDIT_SIGNALS + 2 }, (_, i) => event(-100 + i, "token.create", { type: "user", id: `u${i}` }));
    const { fakes, emitted, run } = setup(many);
    expect(await run()).toMatchObject({ signalled: MAX_AUDIT_SIGNALS, deferred: 1 });
    fakes.clock.advance("1m");
    await run();
    expect(emitted).toHaveLength(MAX_AUDIT_SIGNALS + 2);
  });
});

describe("the audit log client", () => {
  it("asks for the window with the audit token", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fetchImpl = (async (url: URL, init: RequestInit) => ((seen = { url: String(url), auth: new Headers(init.headers).get("authorization") }), new Response("{}"))) as unknown as typeof fetch;
    await cloudflareAuditLog({ accountId: async () => "acct", token: async () => "tok" }, fetchImpl).list("2026-10-22T00:00:00Z", "2026-10-22T01:00:00Z");
    expect(seen?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/logs/audit?since=2026-10-22T00%3A00%3A00Z&before=2026-10-22T01%3A00%3A00Z&limit=100");
    expect(seen?.auth).toBe("Bearer tok");
  });

  it("reads both entry shapes the API documents", () => {
    const [a, b] = parseAuditEvents({
      result: [
        { action: "zone.settings.change", actor: { email: "u@x", id: "1" }, resources: [{ resource_id: "z", resource_type: "zone" }], timestamp: "2026-10-22T00:00:00Z" },
        { action: { type: "token.create" }, actor: { type: "token", token_id: "ci-1" }, resource: { id: "t" }, when: "2026-10-22T00:00:01Z" },
      ],
    });
    expect(a).toMatchObject({ action: "zone.settings.change", actor: { kind: "user", email: "u@x" } });
    expect(b).toMatchObject({ action: "token.create", actor: { kind: "token", id: "ci-1" }, resources: [{ id: "t" }] });
    expect(parseAuditEvents({ result: [{ action: "x" }, "nope"] })).toEqual([]);
  });
});
