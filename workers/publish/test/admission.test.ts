import { SOFT_RATE_LIMIT_INTERVAL_MS } from "@packserver/core/publishing";
import { describe, expect, it } from "vitest";
import { createWorld, ZSTD_BYTES, type Body, type TestWorld } from "./harness";

const MiB = 1024 * 1024;
const DAY = 86_400_000;

async function body(res: Response) {
  return (await res.json()) as Body;
}

/** One owner of an `@acme` scope that holds an existing pack. */
function acme(world: TestWorld, opts: { verifiedDomain?: string } = {}) {
  const owner = world.seed.user();
  const scope = world.seed.scope("acme", { members: [[owner, "owner"]], ...(opts.verifiedDomain ? { verifiedDomain: opts.verifiedDomain } : {}) });
  return { owner, scope };
}

describe("step 1 and 2: admission and integrity", () => {
  it("admits a publish, records admission and integrity, and starts the workflow with a key", async () => {
    const world = createWorld();
    acme(world);
    const { res } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0" });
    expect(res.status).toBe(201);
    const run = await body(res);
    expect(run).toMatchObject({ kind: "publish", pack: "@acme/gcp", version: "1.0.0", status: "running", verdict: null, queued: null });
    expect(run.milestones.map((m) => [m.step, m.outcome])).toEqual([["admission", "ok"], ["integrity", "ok"]]);
    expect(world.validator.requests).toEqual([
      expect.objectContaining({ run_id: run.run_id, pack: "@acme/gcp", version: "1.0.0", dry_run: false, source: "oidc" }),
    ]);
    expect(Object.keys(world.validator.requests[0] as object).sort()).toEqual(
      ["credential_id", "declared_sha256", "dry_run", "pack", "run_id", "source", "staging_key", "version"],
    );
  });

  it("leaves the run queued when the validator does not take it, and offers it again on a replay", async () => {
    const world = createWorld();
    acme(world);
    world.validator.status = 404;
    const { res, credential } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0" });
    const first = await body(res);
    expect(first.status).toBe("queued");
    expect(world.db.prepare(`select dispatch_attempts as n from validation_runs`).get()).toEqual({ n: 1 });

    world.validator.status = 200;
    const again = await world.post(credential.path, { sha256: credential.sha256 }, credential.secret);
    expect(again.status).toBe(200);
    expect(await body(again)).toMatchObject({ run_id: first.run_id, status: "running" });
    expect(world.db.prepare(`select count(*) as n from validation_runs`).get()).toEqual({ n: 1 });
  });

  it("answers a replay with different bytes as already existing", async () => {
    const world = createWorld();
    acme(world);
    const { credential } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0" });
    const other = await world.post(credential.path, { sha256: "d".repeat(64) }, credential.secret);
    expect(await body(other)).toMatchObject({ reason: "exists" });
  });

  it.each([
    ["a hash that does not match", ZSTD_BYTES(1024), "e".repeat(64), "integrity.sha256_mismatch"],
    ["a gzip archive", Uint8Array.from([0x1f, 0x8b, 8, 0, ...new Array(100).fill(7)]), undefined, "integrity.not_zstd"],
  ])("fails %s at integrity before the validator is asked", async (_what, bytes, sha256, reason) => {
    const world = createWorld();
    acme(world);
    const { res } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0", bytes, ...(sha256 ? { sha256 } : {}) });
    expect(await body(res)).toMatchObject({ status: "finished", verdict: "fail", reason });
    expect(world.validator.requests).toEqual([]);
  });

  it("fails an object stored over 3 MiB, however small the credential said it would be, and passes 3 MiB exactly", async () => {
    const world = createWorld();
    acme(world);
    const over = await world.staged({ scope: "acme", pack: "big", version: "1.0.0", bytes: ZSTD_BYTES(3 * MiB + 1) });
    expect(await body(await world.post(over.path, { sha256: over.sha256 }, over.secret))).toMatchObject({ verdict: "fail", reason: "integrity.oversize" });
    const exact = await world.publish({ scope: "acme", pack: "exact", version: "1.0.0", bytes: ZSTD_BYTES(3 * MiB) });
    expect(await body(exact.res)).toMatchObject({ status: "running", verdict: null });
  });

  it("refuses to start before the upload is confirmed", async () => {
    const world = createWorld();
    acme(world);
    const credential = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0" });
    world.db.prepare(`update upload_credentials set uploaded_at = null where id = ?`).run(credential.id);
    const res = await world.post(credential.path, { sha256: credential.sha256 }, credential.secret);
    expect(res.status).toBe(409);
  });

  it("refuses without a credential, with one for another pack, and with a malformed hash", async () => {
    const world = createWorld();
    acme(world);
    const credential = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0" });
    expect((await world.post(credential.path, { sha256: credential.sha256 })).status).toBe(401);
    expect(await body(await world.post("/api/publish/@acme/gcp/1.0.1", { sha256: credential.sha256 }, credential.secret))).toMatchObject({ reason: "forbidden" });
    expect((await world.post(credential.path, { sha256: "nope" }, credential.secret)).status).toBe(400);
  });

  it("refuses a held scope, without consuming a count", async () => {
    const world = createWorld();
    const owner = world.seed.user();
    world.seed.scope("held", { state: "held", members: [[owner, "owner"]] });
    const { res } = await world.publish({ scope: "held", pack: "p", version: "1.0.0" });
    expect(await body(res)).toMatchObject({ reason: "forbidden" });
    expect(world.db.prepare(`select count(*) as n from validation_runs`).get()).toEqual({ n: 0 });
    expect([...world.doStorage.keys()].some((key) => key.startsWith("Quota/"))).toBe(false);
  });
});

describe("REQ-PUB-017: a version exists once", () => {
  it("refuses a version that is published, retired, or already in flight, and lets a failed run be tried again", async () => {
    const world = createWorld();
    const { scope } = acme(world);
    world.seed.version(world.seed.pack(scope, "gcp"), "1.0.0");
    expect(await body((await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0" })).res)).toMatchObject({ reason: "exists" });

    world.db.prepare(`insert into retired_names (kind, name, retired_at) values ('version', '@acme/gcp@1.0.1', ?)`).run(new Date().toISOString());
    expect(await body((await world.publish({ scope: "acme", pack: "gcp", version: "1.0.1" })).res)).toMatchObject({ reason: "exists" });

    expect((await world.publish({ scope: "acme", pack: "gcp", version: "1.0.2" })).res.status).toBe(201);
    expect(await body((await world.publish({ scope: "acme", pack: "gcp", version: "1.0.2" })).res)).toMatchObject({ reason: "exists" });

    const failed = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.3", sha256: "e".repeat(64) });
    expect(await body(failed.res)).toMatchObject({ verdict: "fail" });
    expect((await world.publish({ scope: "acme", pack: "gcp", version: "1.0.3" })).res.status).toBe(201);
  });
});

describe("REQ-PUB-026, REQ-ABUSE-003: daily caps", () => {
  it("allows 5 new packs a day to a plain scope and 20 to a verified one, and starts again at midnight UTC", async () => {
    const world = createWorld();
    acme(world);
    const owner = world.seed.user();
    world.seed.scope("verified", { verifiedDomain: "verified.example", members: [[owner, "owner"]] });
    for (let i = 1; i <= 5; i++) expect((await world.publish({ scope: "acme", pack: `p${i}`, version: "1.0.0" })).res.status).toBe(201);
    const sixth = await world.publish({ scope: "acme", pack: "p6", version: "1.0.0" });
    expect(sixth.res.status).toBe(403);
    const refused = await body(sixth.res);
    expect(refused).toMatchObject({ reason: "quota" });
    expect(refused.message).toMatch(/new packs in @acme is capped at 5 a day.*T00:00:00/);
    expect(Number(sixth.res.headers.get("retry-after"))).toBeGreaterThan(0);

    for (let i = 1; i <= 20; i++) expect((await world.publish({ scope: "verified", pack: `p${i}`, version: "1.0.0" })).res.status).toBe(201);
    expect((await world.publish({ scope: "verified", pack: "p21", version: "1.0.0" })).res.status).toBe(403);

    world.clock.advance(DAY);
    expect((await world.publish({ scope: "acme", pack: "p6", version: "1.0.0" })).res.status).toBe(201);
    expect((await world.publish({ scope: "verified", pack: "p21", version: "1.0.0" })).res.status).toBe(201);
  });

  it("counts a pack as new once however many versions or attempts a day brings", async () => {
    const world = createWorld();
    acme(world);
    for (let i = 1; i <= 4; i++) await world.publish({ scope: "acme", pack: `p${i}`, version: "1.0.0" });
    await world.publish({ scope: "acme", pack: "p5", version: "1.0.0", sha256: "e".repeat(64) });
    expect((await world.publish({ scope: "acme", pack: "p5", version: "1.0.0" })).res.status).toBe(201);
    expect((await world.publish({ scope: "acme", pack: "p5", version: "1.0.1" })).res.status).toBe(201);
    expect((await world.publish({ scope: "acme", pack: "p6", version: "1.0.0" })).res.status).toBe(403);
  });

  it("accepts 20 new versions of one pack a day and refuses the 21st", async () => {
    const world = createWorld();
    const { scope } = acme(world);
    world.seed.pack(scope, "gcp");
    for (let i = 0; i < 20; i++) expect((await world.publish({ scope: "acme", pack: "gcp", version: `1.0.${i}` })).res.status).toBe(201);
    const next = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.20" });
    expect(await body(next.res)).toMatchObject({ reason: "quota" });
  });

  it("keeps the new-pack cap exact under ten concurrent attempts", async () => {
    const world = createWorld();
    acme(world);
    const credentials = await Promise.all(Array.from({ length: 10 }, (_, i) => world.staged({ scope: "acme", pack: `race${i}`, version: "1.0.0" })));
    const answers = await Promise.all(credentials.map((c) => world.post(c.path, { sha256: c.sha256 }, c.secret)));
    expect(answers.filter((a) => a.status === 201)).toHaveLength(5);
    expect(answers.filter((a) => a.status === 403)).toHaveLength(5);
    const counter = [...world.doStorage].find(([key]) => key.startsWith("Quota/new_packs_per_scope"))![1];
    expect(counter.values.get("count")).toBe(5);
  });
});

describe("REQ-PUB-027: concurrent publishes of one version", () => {
  it("yields one run and one new-pack count out of five concurrent publishes", async () => {
    const world = createWorld();
    acme(world);
    for (let i = 1; i <= 4; i++) await world.publish({ scope: "acme", pack: `old${i}`, version: "1.0.0" });
    const credentials = await Promise.all(Array.from({ length: 5 }, () => world.staged({ scope: "acme", pack: "new", version: "1.0.0" })));
    const answers = await Promise.all(credentials.map((c) => world.post(c.path, { sha256: c.sha256 }, c.secret)));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(world.db.prepare(`select count(*) as n from validation_runs where pack_name = 'new'`).get()).toEqual({ n: 1 });
    expect((await world.publish({ scope: "acme", pack: "another", version: "1.0.0" })).res.status).toBe(403);
  });

  it("admits two versions of one pack one after the other under the scope's lock", async () => {
    const world = createWorld();
    const { scope } = acme(world);
    world.seed.pack(scope, "gcp");
    const credentials = await Promise.all(["1.0.0", "1.1.0"].map((version) => world.staged({ scope: "acme", pack: "gcp", version })));
    const answers = await Promise.all(credentials.map((c) => world.post(c.path, { sha256: c.sha256 }, c.secret)));
    expect(answers.map((a) => a.status)).toEqual([201, 201]);
    const lock = world.doStorage.get("ScopeCoordinator/acme");
    expect(lock?.values.has("lock")).toBe(false);
  });
});

describe("REQ-VAL-021: runs and dry-runs", () => {
  async function dryRunCredential(world: TestWorld, userId: string, n: number) {
    return world.staged({ scope: "acme", pack: "gcp", version: `0.0.${n}`, userId, lifetime: "dry-run" });
  }

  it("lets a settled publisher start 60 runs, 20 of them dry-runs, and refuses the 61st and the 21st dry-run", async () => {
    const world = createWorld();
    const owner = world.seed.user({ ageDays: 30 });
    const scope = world.seed.scope("acme", { members: [[owner, "owner"]] });
    world.seed.version(world.seed.pack(scope, "gcp"), "0.9.0");
    for (let i = 0; i < 20; i++) {
      const c = await dryRunCredential(world, owner, i);
      expect((await world.post("/api/dry-run", { sha256: c.sha256 }, c.secret)).status).toBe(201);
    }
    const extra = await dryRunCredential(world, owner, 20);
    expect(await body(await world.post("/api/dry-run", { sha256: extra.sha256 }, extra.secret))).toMatchObject({ reason: "quota" });
    for (let i = 0; i < 4; i++) world.seed.pack(scope, `more${i}`);
    for (let i = 0; i < 40; i++) {
      const c = await world.staged({ scope: "acme", pack: `more${i % 4}`, version: `1.0.${Math.floor(i / 4)}`, userId: owner });
      expect((await world.post(c.path, { sha256: c.sha256 }, c.secret)).status).toBe(201);
    }
    const sixtyFirst = await world.staged({ scope: "acme", pack: "more0", version: "2.0.0", userId: owner });
    const refused = await body(await world.post(sixtyFirst.path, { sha256: sixtyFirst.sha256 }, sixtyFirst.secret));
    expect(refused).toMatchObject({ reason: "quota" });
    expect(refused.message).toMatch(/validation runs is capped at 60/);
  });

  it("limits a young account with no promoted pack to 3 dry-runs, and lifts it once the account is 7 days old", async () => {
    const world = createWorld();
    const owner = world.seed.user({ ageDays: 2 });
    world.seed.scope("acme", { members: [[owner, "owner"]] });
    for (let i = 0; i < 3; i++) {
      const c = await dryRunCredential(world, owner, i);
      expect((await world.post("/api/dry-run", { sha256: c.sha256 }, c.secret)).status).toBe(201);
    }
    const fourth = await dryRunCredential(world, owner, 3);
    expect(await body(await world.post("/api/dry-run", { sha256: fourth.sha256 }, fourth.secret))).toMatchObject({ reason: "quota" });
    world.clock.advance(6 * DAY);
    const later = await dryRunCredential(world, owner, 4);
    expect((await world.post("/api/dry-run", { sha256: later.sha256 }, later.secret)).status).toBe(201);
  });

  it("queues a young account's dry-run behind the others once the sandbox budget is spent", async () => {
    const world = createWorld();
    const young = world.seed.user({ ageDays: 1 });
    const settled = world.seed.user({ ageDays: 40 });
    world.seed.scope("acme", { members: [[young, "owner"]] });
    const other = world.seed.scope("other", { members: [[settled, "owner"]] });
    world.seed.version(world.seed.pack(other, "gcp"), "0.9.0");
    world.db.prepare(`insert into feature_flags (key, value, security, updated_at) values ('sandbox_daily_minutes', '100', 0, ?)`).run(new Date().toISOString());
    const day = new Date(world.clock.now()).toISOString().slice(0, 10);
    world.db.prepare(`insert into sandbox_usage (day, minutes) values (?, 100)`).run(day);

    const mine = await dryRunCredential(world, young, 1);
    const queued = await body(await world.post("/api/dry-run", { sha256: mine.sha256 }, mine.secret));
    expect(queued).toMatchObject({ status: "queued", queued: { reason: "sandbox-budget" } });
    expect(Date.parse(queued.queued!.until)).toBe(Date.parse(`${day}T00:00:00.000Z`) + DAY);

    const theirs = await world.staged({ scope: "other", pack: "gcp", version: "0.0.2", userId: settled, lifetime: "dry-run" });
    expect(await body(await world.post("/api/dry-run", { sha256: theirs.sha256 }, theirs.secret))).toMatchObject({ status: "running", queued: null });
    const publish = await world.publish({ scope: "acme", pack: "mine", version: "1.0.0", userId: young });
    expect(await body(publish.res)).toMatchObject({ status: "running" });
  });
});

describe("REQ-VAL-017: ten failed runs queue a publisher", () => {
  it("starts a soft-limited publisher's runs one every ten minutes, refuses none, and frees them at midnight UTC", async () => {
    const world = createWorld();
    const owner = world.seed.user();
    const other = world.seed.user();
    world.seed.scope("acme", { members: [[owner, "owner"]] });
    world.seed.scope("other", { members: [[other, "owner"]] });
    for (let i = 0; i < 10; i++) {
      expect(await body((await world.publish({ scope: "acme", pack: `f${i % 5}`, version: `1.0.${i}`, userId: owner, sha256: "e".repeat(64) })).res)).toMatchObject({ verdict: "fail" });
    }
    for (let i = 0; i < 9; i++) await world.publish({ scope: "other", pack: `f${i % 5}`, version: `1.0.${i}`, userId: other, sha256: "e".repeat(64) });

    const now = world.clock.now();
    const queued = [];
    for (let i = 0; i < 3; i++) queued.push(await body((await world.publish({ scope: "acme", pack: "f0", version: `2.0.${i}`, userId: owner })).res));
    expect(queued.map((q) => q.queued?.reason)).toEqual(["soft-rate-limit", "soft-rate-limit", "soft-rate-limit"]);
    expect(queued.map((q) => Date.parse(q.queued!.start_after) - now)).toEqual([1, 2, 3].map((k) => k * SOFT_RATE_LIMIT_INTERVAL_MS));
    expect(queued.every((q) => q.status === "queued")).toBe(true);
    expect(Date.parse(queued[0]!.queued!.until)).toBeGreaterThan(now);

    const neighbour = await body((await world.publish({ scope: "other", pack: "f0", version: "2.0.0", userId: other })).res);
    expect(neighbour).toMatchObject({ status: "running", queued: null });

    world.clock.advance(DAY);
    expect(await body((await world.publish({ scope: "acme", pack: "f0", version: "2.1.0", userId: owner })).res)).toMatchObject({ status: "running", queued: null });
  });
});

describe("REQ-OPS-001: a synthetic scope", () => {
  it("is marked for the validator, expires after a day, and is held to the daily caps like any scope", async () => {
    const world = createWorld();
    world.seed.scope("probe", { kind: "synthetic" });
    for (let i = 0; i < 5; i++) expect((await world.publish({ scope: "probe", pack: `p${i}`, version: "1.0.0" })).res.status).toBe(201);
    expect((await world.publish({ scope: "probe", pack: "p5", version: "1.0.0" })).res.status).toBe(403);
    const row = world.db.prepare(`select synthetic, prose_screen, expires_at, created_at from validation_runs limit 1`).get() as { synthetic: number; prose_screen: number; expires_at: string; created_at: string };
    expect(row.synthetic).toBe(1);
    expect(row.prose_screen).toBe(0);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(DAY);
  });

  it("lets a version be published again once its earlier synthetic run has expired, and not before", async () => {
    const world = createWorld();
    world.seed.scope("probe", { kind: "synthetic" });
    expect((await world.publish({ scope: "probe", pack: "p", version: "1.0.0" })).res.status).toBe(201);
    world.clock.advance(DAY - 1);
    expect(await body((await world.publish({ scope: "probe", pack: "p", version: "1.0.0" })).res)).toMatchObject({ reason: "exists" });
    world.clock.advance(1);
    expect((await world.publish({ scope: "probe", pack: "p", version: "1.0.0" })).res.status).toBe(201);
  });
});

describe("D44: new packs per account across scopes", () => {
  it("stops an account at 20 new packs a day however many scopes it spreads them over", async () => {
    const world = createWorld();
    const owner = world.seed.user();
    for (let s = 1; s <= 5; s++) world.seed.scope(`s${s}`, { members: [[owner, "owner"]] });
    for (let n = 0; n < 20; n++) {
      const res = (await world.publish({ scope: `s${(n % 4) + 1}`, pack: `p${n}`, version: "1.0.0", userId: owner })).res;
      expect(res.status).toBe(201);
    }
    const refused = await world.publish({ scope: "s5", pack: "p20", version: "1.0.0", userId: owner });
    expect(refused.res.status).toBe(403);
    expect(await body(refused.res)).toMatchObject({ reason: "quota", message: expect.stringContaining("new packs by this account") });

    world.clock.advance(DAY);
    expect((await world.publish({ scope: "s5", pack: "p20", version: "1.0.0", userId: owner })).res.status).toBe(201);
  });
});

describe("REQ-AUDIT-007: refusals are audited", () => {
  const events = (world: TestWorld) => world.fakes.queues.AUDIT_QUEUE!.messages as Array<{ action: string; detail: Record<string, unknown>; target?: string }>;

  it("records a held scope and a cap hit as publish.refused", async () => {
    const world = createWorld();
    const owner = world.seed.user();
    world.seed.scope("held", { state: "held", members: [[owner, "owner"]] });
    world.seed.scope("acme", { members: [[owner, "owner"]] });
    expect((await world.publish({ scope: "held", pack: "p", version: "1.0.0", userId: owner })).res.status).toBe(403);
    for (let i = 0; i < 5; i++) await world.publish({ scope: "acme", pack: `p${i}`, version: "1.0.0", userId: owner });
    expect((await world.publish({ scope: "acme", pack: "p5", version: "1.0.0", userId: owner })).res.status).toBe(403);

    expect(events(world).map((e) => [e.action, e.detail.reason, e.target])).toEqual([
      ["publish.refused", "scope-held", "@held/p@1.0.0"],
      ["publish.refused", "quota:new_packs_per_scope", "@acme/p5@1.0.0"],
    ]);
  });
});
