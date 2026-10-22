import { describe, expect, it } from "vitest";
import { acceptDoResult, DO_RPC, DO_RPC_SCHEMA_VERSION, type QuotaRpc, type ScopeCoordinatorRpc, type RootCoordinatorRpc } from "./durable-objects";

const sha = "a".repeat(64);

describe("Durable Object RPC contracts", () => {
  it("make every method of every object return schema_version", () => {
    for (const methods of Object.values(DO_RPC)) {
      for (const method of Object.values(methods)) {
        expect(method.result.shape).toHaveProperty("schema_version");
      }
    }
  });
  it("expose ping on each object for the self-test", () => {
    for (const methods of Object.values(DO_RPC)) expect(methods).toHaveProperty("ping");
  });
  it("refuse a result that omits schema_version", () => {
    expect(DO_RPC.Quota.consume.result.safeParse({ allowed: true, count: 1, cap: 5 }).success).toBe(false);
    expect(
      DO_RPC.Quota.consume.result.safeParse({ schema_version: DO_RPC_SCHEMA_VERSION, allowed: true, count: 1, cap: 5 }).success,
    ).toBe(true);
  });
  it("have no method without a caller in the trust table", () => {
    expect(Object.keys(DO_RPC.RootCoordinator).sort()).toEqual(["notifyScopeChange", "ping"]);
  });
  it("accept a result at the caller's schema_version or the next one", () => {
    expect(acceptDoResult(1, { schema_version: 1 })).toEqual({ ok: true, schema_version: 1 });
    expect(acceptDoResult(1, { schema_version: 2 }).ok).toBe(true);
    expect(acceptDoResult(2, { schema_version: 1 })).toEqual({ ok: false, reason: "schema.unsupported", schema_version: 1 });
    expect(acceptDoResult(1, { schema_version: 3 }).ok).toBe(false);
    expect(acceptDoResult(1, {})).toEqual({ ok: false, reason: "malformed" });
    expect(acceptDoResult(1, null).ok).toBe(false);
  });
  it("refuse a quota call with an unknown kind or a non-date day", () => {
    const ok = { kind: "dry_runs", principal: "p", day: "2026-10-22", cap: 5 };
    expect(DO_RPC.Quota.consume.args.safeParse([ok]).success).toBe(true);
    expect(DO_RPC.Quota.consume.args.safeParse([{ ...ok, kind: "everything" }]).success).toBe(false);
    expect(DO_RPC.Quota.consume.args.safeParse([{ ...ok, day: "yesterday" }]).success).toBe(false);
    expect(DO_RPC.Quota.consume.args.safeParse([{ ...ok, cap: 0 }]).success).toBe(false);
  });
  it("refuse a root notification with a malformed hash", () => {
    expect(DO_RPC.RootCoordinator.notifyScopeChange.args.safeParse([{ scope: "acme", sha256: sha, serial: 1 }]).success).toBe(true);
    expect(DO_RPC.RootCoordinator.notifyScopeChange.args.safeParse([{ scope: "acme", sha256: "zz", serial: 1 }]).success).toBe(false);
  });
  it("derive typed interfaces whose results carry schema_version", async () => {
    const quota: QuotaRpc = {
      ping: async () => ({ schema_version: 1, ok: true }),
      consume: async () => ({ schema_version: 1, allowed: true, count: 1, cap: 5 }),
      peek: async () => ({ schema_version: 1, count: 1 }),
    };
    const scope: Pick<ScopeCoordinatorRpc, "ping"> = { ping: quota.ping };
    const root: Pick<RootCoordinatorRpc, "ping"> = { ping: quota.ping };
    expect((await quota.consume({ kind: "reviews", principal: "p", day: "2026-10-22", cap: 5 })).schema_version).toBe(1);
    expect(await scope.ping()).toEqual(await root.ping());
  });
});
