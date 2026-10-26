import { DO_RPC, DO_RPC_SCHEMA_VERSION } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { ScopeCoordinatorLogic, REBUILD_DEBOUNCE_MS } from "../src/coordinator";
import { MemoryDoStorage } from "../src/do-storage";
import { COUNTER_LIFETIME_MS, QuotaCounter, quotaName } from "../src/quota";
import { RootCoordinatorLogic, ROOT_BATCH_MS, ROOT_DAILY_MS, ROOT_RETRY_MS } from "../src/root-coordinator";
import { migratedD1 } from "@packserver/core/identity/testing";

const DAY = "2026-10-22";
const sha = (c: string) => c.repeat(64);

function clockAt(start = Date.UTC(2026, 9, 22, 12)) {
  const clock = { ms: start, now: () => clock.ms, advance: (by: number) => void (clock.ms += by) };
  return clock;
}

describe("Quota", () => {
  const key = { kind: "validation_runs", principal: "user:u1", day: DAY } as const;

  it("counts to the cap and refuses beyond it, reporting the count it holds", async () => {
    const clock = clockAt();
    const counter = new QuotaCounter(new MemoryDoStorage(), clock.now);
    for (let i = 1; i <= 3; i++) expect(await counter.consume({ ...key, cap: 3 })).toMatchObject({ allowed: true, count: i, cap: 3 });
    expect(await counter.consume({ ...key, cap: 3 })).toMatchObject({ allowed: false, count: 3 });
    expect(await counter.peek(key)).toMatchObject({ count: 3 });
  });

  it("answers every result with the schema version and a shape the contract accepts", async () => {
    const counter = new QuotaCounter(new MemoryDoStorage(), clockAt().now);
    const consumed = await counter.consume({ ...key, cap: 2 });
    expect(DO_RPC.Quota.consume.result.parse(consumed).schema_version).toBe(DO_RPC_SCHEMA_VERSION);
    expect(DO_RPC.Quota.peek.result.parse(await counter.peek(key)).count).toBe(1);
    expect(DO_RPC.Quota.ping.result.parse(await counter.ping()).ok).toBe(true);
  });

  it("belongs to one key and refuses another", async () => {
    const counter = new QuotaCounter(new MemoryDoStorage(), clockAt().now);
    await counter.consume({ ...key, cap: 3 });
    await expect(counter.consume({ ...key, principal: "user:u2", cap: 3 })).rejects.toThrow(/another key/);
    expect(quotaName(key.kind, key.principal, key.day)).toBe("validation_runs|user:u1|2026-10-22");
  });

  it("arms one expiry alarm when it first counts", async () => {
    const clock = clockAt();
    const storage = new MemoryDoStorage();
    const counter = new QuotaCounter(storage, clock.now);
    await counter.consume({ ...key, cap: 5 });
    clock.advance(1000);
    await counter.consume({ ...key, cap: 5 });
    expect(storage.alarm).toBe(Date.UTC(2026, 9, 22, 12) + COUNTER_LIFETIME_MS);
  });
});

describe("ScopeCoordinator", () => {
  function setup() {
    const clock = clockAt();
    const storage = new MemoryDoStorage();
    const { d1, db } = migratedD1();
    const built: string[] = [];
    const notified: unknown[] = [];
    const logic = new ScopeCoordinatorLogic(storage, clock.now, {
      d1,
      indexes: { rebuild: async (scope) => (built.push(scope), { sha256: sha(String(built.length)), serial: built.length }) },
      root: { scopeChanged: async (change) => void notified.push(change) },
    });
    return { clock, storage, logic, db, built, notified };
  }

  it("grants the lock to one run at a time, to the same run again, and to the next once released or expired", async () => {
    const { logic, clock } = setup();
    expect(await logic.acquireLock({ run_id: "a", ttl_s: 10 })).toMatchObject({ acquired: true, holder_run_id: "a" });
    expect(await logic.acquireLock({ run_id: "b", ttl_s: 10 })).toMatchObject({ acquired: false, holder_run_id: "a" });
    expect(await logic.acquireLock({ run_id: "a", ttl_s: 10 })).toMatchObject({ acquired: true });
    expect(await logic.releaseLock({ run_id: "b" })).toMatchObject({ released: false });
    expect(await logic.releaseLock({ run_id: "a" })).toMatchObject({ released: true });
    expect(await logic.acquireLock({ run_id: "b", ttl_s: 10 })).toMatchObject({ acquired: true });
    clock.advance(10_000);
    expect(await logic.acquireLock({ run_id: "c", ttl_s: 10 })).toMatchObject({ acquired: true });
  });

  it("promotes an approved version once, in one batch, and says so on a repeat", async () => {
    const { logic, db } = setup();
    db.exec(`insert into users (id, created_at) values ('u', 'x'); insert into scopes (id, name, kind, state, created_at) values ('s', 'acme', 'org', 'active', 'x');
      insert into packs (id, scope_id, name, visibility, created_at) values ('p', 's', 'gcp', 'public', 'x');
      insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values ('v1', 'p', '1.0.0', 'approved', '${sha("a")}', 1, 0, 0),
        ('v2', 'p', '1.1.0', 'pending', '${sha("b")}', 1, 0, 0);`);
    expect(await logic.insertVersion({ run_id: "r", pack: "@acme/gcp", version: "1.0.0" })).toMatchObject({ promoted: true, already_promoted: false });
    expect(db.prepare(`select state, published_at from pack_versions where id = 'v1'`).get()).toEqual({ state: "active", published_at: "2026-10-22T12:00:00.000Z" });
    expect(await logic.insertVersion({ run_id: "r", pack: "@acme/gcp", version: "1.0.0" })).toMatchObject({ promoted: false, already_promoted: true });
    expect(await logic.insertVersion({ run_id: "r", pack: "@acme/gcp", version: "1.1.0" })).toMatchObject({ promoted: false, already_promoted: false });
    expect(await logic.insertVersion({ run_id: "r", pack: "@acme/gcp", version: "9.9.9" })).toMatchObject({ promoted: false, already_promoted: false });
  });

  it("rebuilds a scope's index and hands the root its hash and serial", async () => {
    const { logic, built, notified } = setup();
    expect(await logic.rebuildIndex({ scope: "acme" })).toMatchObject({ sha256: sha("1"), serial: 1 });
    expect(built).toEqual(["acme"]);
    expect(notified).toEqual([{ scope: "acme", sha256: sha("1"), serial: 1 }]);
  });

  it("delays a rebuild asked for inside the debounce window to the alarm instead of skipping it", async () => {
    const { logic, clock, storage, built } = setup();
    await logic.rebuildIndex({ scope: "acme" });
    clock.advance(1000);
    expect(await logic.rebuildIndex({ scope: "acme" })).toMatchObject({ sha256: sha("1"), serial: 1 });
    expect(built).toHaveLength(1);
    expect(storage.alarm).toBe(Date.UTC(2026, 9, 22, 12) + REBUILD_DEBOUNCE_MS);
    clock.advance(REBUILD_DEBOUNCE_MS);
    await logic.alarm();
    expect(built).toHaveLength(2);
    expect(await storage.get("pending")).toBeUndefined();
  });

  it("runs one rebuild at a time and, for requests arriving meanwhile, exactly one more", async () => {
    const clock = clockAt();
    const { d1 } = migratedD1();
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    let calls = 0;
    const logic = new ScopeCoordinatorLogic(new MemoryDoStorage(), clock.now, {
      d1,
      indexes: {
        rebuild: async () => {
          const n = ++calls;
          peak = Math.max(peak, ++active);
          await new Promise<void>((open) => gates.push(open));
          active--;
          return { sha256: sha(String(n)), serial: n };
        },
      },
      root: { scopeChanged: async () => {} },
    });
    const first = logic.rebuildIndex({ scope: "acme" });
    await Promise.resolve();
    const second = logic.rebuildIndex({ scope: "acme" });
    const third = logic.rebuildIndex({ scope: "acme" });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    gates[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    gates[1]!();
    const results = await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(results.map((r) => r.serial)).toEqual([2, 2, 2]);
  });

  it("does nothing on an alarm with nothing pending", async () => {
    const { logic, built } = setup();
    await logic.alarm();
    expect(built).toEqual([]);
  });
});

describe("RootCoordinator", () => {
  function setup(signer?: (request: { unsigned: { serial: number; scopes: Array<{ scope: string }> } }) => Promise<void>) {
    const clock = clockAt();
    const storage = new MemoryDoStorage();
    const signed: Array<{ serial: number; scopes: string[]; generated_at: string }> = [];
    const logic = new RootCoordinatorLogic(storage, clock.now, {
      signAndWriteRoot: async (request) => {
        const unsigned = request.unsigned as unknown as { serial: number; generated_at: string; scopes: Array<{ scope: string }> };
        if (signer) await signer(request as never);
        signed.push({ serial: unsigned.serial, generated_at: unsigned.generated_at, scopes: unsigned.scopes.map((s) => s.scope) });
        return { sha256: sha("r"), serial: unsigned.serial };
      },
    });
    return { clock, storage, logic, signed };
  }

  it("batches scope changes arriving within ten seconds into one signed root", async () => {
    const { logic, clock, storage, signed } = setup();
    expect(await logic.notifyScopeChange({ scope: "b", sha256: sha("b"), serial: 1 })).toMatchObject({ queued: true });
    clock.advance(4000);
    await logic.notifyScopeChange({ scope: "a", sha256: sha("a"), serial: 1 });
    expect(storage.alarm).toBe(Date.UTC(2026, 9, 22, 12) + ROOT_BATCH_MS);
    clock.advance(ROOT_BATCH_MS - 4000);
    await logic.alarm();
    expect(signed).toEqual([{ serial: 1, scopes: ["a", "b"], generated_at: "2026-10-22T12:00:10.000Z" }]);
    expect(await logic.status()).toMatchObject({ root_serial: 1, dirty: false, failure: null });
  });

  it("ignores a change that is not newer than the scope's current serial", async () => {
    const { logic } = setup();
    await logic.notifyScopeChange({ scope: "a", sha256: sha("a"), serial: 2 });
    expect(await logic.notifyScopeChange({ scope: "a", sha256: sha("x"), serial: 2 })).toMatchObject({ queued: false });
    expect(await logic.notifyScopeChange({ scope: "a", sha256: sha("x"), serial: 1 })).toMatchObject({ queued: false });
  });

  it("re-signs daily with a fresh serial even when nothing changed", async () => {
    const { logic, clock, storage, signed } = setup();
    await logic.notifyScopeChange({ scope: "a", sha256: sha("a"), serial: 1 });
    clock.advance(ROOT_BATCH_MS);
    await logic.alarm();
    expect(storage.alarm).toBe(clock.now() + ROOT_DAILY_MS);
    clock.advance(ROOT_DAILY_MS);
    await logic.alarm();
    expect(signed.map((s) => s.serial)).toEqual([1, 2]);
    expect(signed[1]!.scopes).toEqual(["a"]);
  });

  it("keeps its work and retries with backoff when the validator cannot sign, then recovers", async () => {
    let failures = 2;
    const { logic, clock, storage, signed } = setup(async () => {
      if (failures-- > 0) throw new Error("the validator has no signAndWriteRoot entrypoint yet");
    });
    await logic.notifyScopeChange({ scope: "a", sha256: sha("a"), serial: 1 });
    clock.advance(ROOT_BATCH_MS);
    await logic.alarm();
    expect(await logic.status()).toMatchObject({ dirty: true, failure: { attempts: 1, message: expect.stringContaining("signAndWriteRoot") } });
    expect(storage.alarm).toBe(clock.now() + ROOT_RETRY_MS);
    clock.advance(ROOT_RETRY_MS);
    await logic.alarm();
    expect(storage.alarm).toBe(clock.now() + 2 * ROOT_RETRY_MS);
    clock.advance(2 * ROOT_RETRY_MS);
    await logic.alarm();
    expect(signed).toHaveLength(1);
    expect(await logic.status()).toMatchObject({ dirty: false, failure: null, root_serial: 1 });
  });

  it("does nothing on an alarm before it has anything to sign", async () => {
    const { logic, signed } = setup();
    await logic.alarm();
    expect(signed).toEqual([]);
  });
});
