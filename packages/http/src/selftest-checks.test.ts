import { verifySelfTestSignature } from "@packserver/core/selftest";
import { FakeClock } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { coordinatorCheck, runSelfTest, serviceCheck, storeChecks, type SelfTestCheck } from "./index";

const range = { min: "20261026000000", max: "20261026100000" };
const run = async (checks: SelfTestCheck[]) => (await runSelfTest({ versionId: "v", releaseId: "r", checks, clock: new FakeClock() })).checks;

const d1With = (names: string[]) => ({
  query: async (sql: string) => ({ rows: sql.includes("d1_migrations") ? names.map((name) => ({ name })) : [{ ok: 1 }], meta: { changes: 0, last_row_id: null } }),
  batch: async () => [],
});

describe("IT-OPS-011 the d1 checks", () => {
  it("passes a head inside the range", async () => {
    const checks = await run(storeChecks({ d1: d1With(["20261026050000_a_b.sql"]), schema: range }));
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["d1.ping", true], ["d1.schema", true]]);
  });

  it("names the head and the range when the head is outside it", async () => {
    const below = await run(storeChecks({ d1: d1With(["20261025000000_a_b.sql"]), schema: range }));
    expect(below[1]).toMatchObject({ name: "d1.schema head=20261025000000 range=20261026000000..20261026100000", ok: false, detail: "failed" });
    const contract = await run(storeChecks({ d1: d1With(["20261026100000_a_b.sql", "20261027000000_a_contract_x.sql"]), schema: range }));
    expect(contract[1]).toMatchObject({ name: expect.stringContaining("head=20261027000000"), ok: false });
  });

  it("serves a head one expand beyond the range", async () => {
    const ahead = await run(storeChecks({ d1: d1With(["20261026100000_a_b.sql", "20261027000000_a_new_column.sql"]), schema: range }));
    expect(ahead[1]).toMatchObject({ name: "d1.schema", ok: true });
  });
});

describe("the store and coordinator checks", () => {
  it("read each store at a canary key and write nothing", async () => {
    const reads: string[] = [];
    const checks = await run(storeChecks({
      kv: { SESSIONS_KV: { get: async (k: string) => (reads.push(`kv ${k}`), null) } },
      r2: { PACKS_PUBLIC: { head: async (k: string) => (reads.push(`r2 ${k}`), null) } },
    }));
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["kv.SESSIONS_KV", true], ["r2.PACKS_PUBLIC", true]]);
    expect(reads).toEqual(["kv @packserver-canary/selftest", "r2 @packserver-canary/selftest"]);
  });

  it("pings the canary scope's coordinator", async () => {
    const calls: unknown[][] = [];
    const durableObjects = { call: async (...args: unknown[]) => (calls.push(args), { schema_version: 1, ok: true as const }) };
    expect(await run([coordinatorCheck(durableObjects as never)])).toMatchObject([{ name: "do.ping", ok: true }]);
    expect(calls).toEqual([["ScopeCoordinator", "@packserver-canary", "ping", []]]);
  });
});

describe("IT-OPS-010 the service checks", () => {
  it("ask the callee for a shallow self-test with a signature of their own each time", async () => {
    const seen: Request[] = [];
    const binding = { fetch: async (r: Request) => (seen.push(r), Response.json({ ok: true })) };
    let n = 0;
    const check = serviceCheck({ callee: "mcp", binding, key: async () => "k", uuid: () => `00000000-0000-4000-8000-00000000000${n++}` });
    expect((await run([check, check])).map((c) => [c.name, c.ok])).toEqual([["service.mcp", true], ["service.mcp", true]]);
    const url = new URL(seen[0]!.url);
    expect([url.pathname, url.search]).toEqual(["/mcp/__selftest", "?shallow=1"]);
    const headers = seen.map((r) => r.headers.get("x-selftest-signature")!);
    expect(headers[0]).not.toEqual(headers[1]);
    expect(await verifySelfTestSignature({ header: headers[0], key: "k", method: "GET", host: "mcp.internal", path: "/mcp/__selftest", nowMs: Date.now() })).toMatchObject({ ok: true });
    expect(headers[0]).toMatch(/k=svc-/);
  });

  it("fail when the callee answers not ok, answers an error or cannot be signed for", async () => {
    const answer = (res: () => Response) => serviceCheck({ callee: "x", binding: { fetch: async () => res() }, key: async () => "k", uuid: () => "nonce-0001" });
    const checks = await run([
      answer(() => Response.json({ ok: false })),
      answer(() => new Response("Not Found", { status: 404 })),
      serviceCheck({ callee: "y", binding: { fetch: async () => Response.json({ ok: true }) }, key: undefined, uuid: () => "n" }),
    ]);
    expect(checks.map((c) => c.ok)).toEqual([false, false, false]);
  });
});
