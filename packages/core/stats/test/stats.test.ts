import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FakeClock, FakeR2 } from "@packserver/ports/fakes";
import { SqliteD1 } from "../../audit/testing";
import {
  HIT_SAMPLE_SCALE, MAX_OBJECTS_PER_RUN, LOG_JOBS, mismatchesOf, observeServerMismatch, packFetchStats, parseLog, pruneFetches, recomputeStats, reportMismatch, runRollup,
  type PrivateDownloads,
} from "../index.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 26, 12, 0, 0);
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

function setup() {
  const d1 = new SqliteD1();
  const clock = new FakeClock(START);
  const ops = new FakeR2();
  let n = 0;
  const pack = async (name: string, over: { visibility?: "public" | "private"; scopeKind?: string; state?: string; version?: string } = {}) => {
    const [scope, packName] = name.slice(1).split("/") as [string, string];
    await d1.query("insert or ignore into scopes (id, name, kind, state, created_at) values (?, ?, 'org', 'active', 'x')", [`scope-${scope}`, scope]);
    if (over.scopeKind) {
      d1.db.exec("pragma ignore_check_constraints = on");
      await d1.query("update scopes set kind = ? where id = ?", [over.scopeKind, `scope-${scope}`]);
      d1.db.exec("pragma ignore_check_constraints = off");
    }
    const id = `pack-${++n}`;
    await d1.query("insert into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, ?, 'x')", [id, `scope-${scope}`, packName, over.visibility ?? "public"]);
    await d1.query(
      "insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, ?, ?, ?, ?, 1, 'x', 0, 0)",
      [`ver-${n}`, id, over.version ?? "1.0.0", over.state ?? "active", HASH],
    );
    return id;
  };
  const record = (pack: string, version: string, network: string, at: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ CacheCacheStatus: "hit", ClientRequestMethod: "GET", ClientRequestPath: `/${pack}/${version}/pack.tar.zst`, EdgeResponseStatus: 200, EdgeStartTimestamp: new Date(at).toISOString(), ClientNetwork: network, ...extra });
  let files = 0;
  const archive = (job: "hits" | "misses", lines: string[], at = clock.now(), gz = false) => {
    const day = new Date(at).toISOString().slice(0, 10).replaceAll("-", "");
    const body = new TextEncoder().encode(lines.join("\n") + "\n");
    return ops.put(`logs/http-requests/${job}/${day}/${String(++files).padStart(4, "0")}.log${gz ? ".gz" : ""}`, gz ? gzipSync(body) : body);
  };
  const run = (privateDownloads?: PrivateDownloads) => runRollup({ d1, ops, clock, ...(privateDownloads && { privateDownloads }) });
  const stats = async (id: string) => d1.rows("select * from pack_stats where pack_id = ?", [id])[0];
  return { d1, clock, ops, pack, record, archive, run, stats };
}

describe("the archive reader", () => {
  it("counts successful GETs of a pack archive that carry a client network, and nothing else", () => {
    const at = START;
    const lines = [
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "198.51.100.0/24" }),
      JSON.stringify({ ClientRequestPath: "/%40acme/x/1.0.0/pack.tar.zst", EdgeResponseStatus: 206, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "2001:db8:0::/48" }),
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", EdgeResponseStatus: 404, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "198.51.100.0/24" }),
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "198.51.100.7" }),
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-26T01:00:00Z" }),
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/meta.json", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "198.51.100.0/24" }),
      JSON.stringify({ ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", ClientRequestMethod: "HEAD", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-26T01:00:00Z", ClientNetwork: "198.51.100.0/24" }),
      "not json",
      "",
    ];
    const parsed = parseLog(lines.join("\n"));
    expect(at).toBe(START);
    expect(parsed.fetches).toEqual([
      { pack: "@acme/x", version: "1.0.0", day: "2026-10-26", network: "198.51.100.0/24" },
      { pack: "@acme/x", version: "1.0.0", day: "2026-10-26", network: "2001:db8:0::/48" },
    ]);
    expect(parsed.skipped).toBe(6);
  });

  it("reads the Logpush job table and the sampling rate from the zone configuration", () => {
    const zone = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../infra/zone/logpush.json"), "utf8")) as { jobs: Array<{ key: string; prefix: string; sampleRate: number }> };
    for (const [key, job] of [["http-cache-hits", "hits"], ["http-cache-misses", "misses"]] as const) {
      const configured = zone.jobs.find((j) => j.key === key)!;
      const ours = LOG_JOBS.find((j) => j.job === job)!;
      expect(configured.prefix.replace("{DATE}", "")).toBe(ours.prefix);
      expect(Math.round(1 / configured.sampleRate)).toBe(ours.weight);
    }
    expect(HIT_SAMPLE_SCALE).toBe(10);
  });
});

describe("the hourly rollup", () => {
  it("counts a network once per version and day, and a hit as ten", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    await t.archive("hits", [
      t.record("@acme/x", "1.0.0", "198.51.100.0/24", START),
      t.record("@acme/x", "1.0.0", "198.51.100.0/24", START + 60_000),
      t.record("@acme/x", "1.0.0", "203.0.113.0/24", START),
    ]);
    await t.archive("misses", [t.record("@acme/x", "1.0.0", "198.51.100.0/24", START, { CacheCacheStatus: "miss" })]);
    const summary = await t.run();
    expect(summary).toMatchObject({ ran: ["hits", "misses"], objects: 2, folded: 4 });
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 11, fetches_7d: 11, fetches_prev_28d: 0 });
    expect(await packFetchStats(t.d1, "@acme/x")).toMatchObject({ fetches30d: 11, distinct30d: 2 });
  });

  it("counts the same network again on the next day and another version the same day", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await t.archive("misses", [
      t.record("@acme/x", "1.0.0", "198.51.100.0/24", START),
      t.record("@acme/x", "1.0.0", "198.51.100.0/24", START + DAY),
      t.record("@acme/x", "2.0.0", "198.51.100.0/24", START),
    ]);
    t.clock.advance("1d");
    await t.run();
    expect(await packFetchStats(t.d1, "@acme/x")).toMatchObject({ fetches30d: 3, distinct30d: 1 });
  });

  it("does nothing the second time for an hour, and nothing twice for a replayed object", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    await t.archive("misses", [t.record("@acme/x", "1.0.0", "198.51.100.0/24", START)]);
    expect((await t.run()).folded).toBe(1);
    expect((await t.run()).ran).toEqual([]);
    t.clock.advance("1h");
    const next = await t.run();
    expect(next).toMatchObject({ ran: ["hits", "misses"], objects: 0, folded: 0 });
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 1 });
    t.d1.db.exec("delete from rollup_files");
    t.clock.advance("1h");
    await t.run();
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 1 });
  });

  it("reads gzip objects and leaves an unfinished run to be repeated", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    await t.archive("misses", [t.record("@acme/x", "1.0.0", "198.51.100.0/24", START)], START, true);
    const broken = { ...t.ops, list: async () => { throw new Error("R2 unavailable"); }, get: t.ops.get.bind(t.ops), head: t.ops.head.bind(t.ops) };
    await expect(runRollup({ d1: t.d1, ops: broken, clock: t.clock })).rejects.toThrow("R2 unavailable");
    expect(t.d1.rows("select * from rollup_runs")).toEqual([]);
    await t.run();
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 1 });
  });

  it("moves counts through the 7-day, previous-28-day and 30-day windows and back to a real zero", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    const net = (i: number) => `198.51.${i}.0/24`;
    await t.archive("misses", [
      ...[0, 1, 2].map((i) => t.record("@acme/x", "1.0.0", net(i), START)),
      ...[0, 1].map((i) => t.record("@acme/x", "1.0.0", net(i), START - 10 * DAY)),
      t.record("@acme/x", "1.0.0", net(9), START - 31 * DAY),
    ], START);
    await t.run();
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 5, fetches_7d: 3, fetches_prev_28d: 3 });
    t.clock.advance("20d");
    await t.run();
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 3, fetches_7d: 0, fetches_prev_28d: 5 });
    t.clock.advance("20d");
    await pruneFetches(t.d1, "2026-12-15");
    await recomputeStats(t.d1, "2026-12-15", "now");
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 0, fetches_7d: 0, fetches_prev_28d: 0 });
    expect(t.d1.rows("select * from fetch_days")).toEqual([]);
  });

  it("writes only the fetch columns of pack_stats", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    await t.d1.query("insert into pack_stats (pack_id, stars, stars_7d, stars_prev_28d, rating, computed_at) values (?, 9, 6, 2, 4.5, 'x')", [id]);
    await t.archive("misses", [t.record("@acme/x", "1.0.0", "198.51.100.0/24", START)]);
    await t.run();
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 1, stars: 9, stars_7d: 6, stars_prev_28d: 2, rating: 4.5 });
  });

  it("ignores unknown, private and synthetic packs in the public archive", async () => {
    const t = setup();
    const priv = await t.pack("@acme/secret", { visibility: "private" });
    const probe = await t.pack("@probe/p", { scopeKind: "synthetic" });
    await t.archive("misses", ["@acme/secret", "@probe/p", "@acme/ghost"].map((p) => t.record(p, "1.0.0", "198.51.100.0/24", START)));
    const summary = await t.run();
    expect(summary).toMatchObject({ folded: 0, ignored: 3 });
    expect(await t.stats(priv)).toBeUndefined();
    expect(await t.stats(probe)).toBeUndefined();
  });

  it("counts private downloads once per principal, version and day, and leaves public packs to the archive", async () => {
    const t = setup();
    const priv = await t.pack("@acme/secret", { visibility: "private" });
    await t.pack("@acme/open");
    const today = "2026-10-26";
    const asked: string[] = [];
    const points: PrivateDownloads = async (since) => {
      asked.push(since);
      return [
        { pack: "@acme/secret", version: "1.0.0", day: today, principal: "p1" },
        { pack: "@acme/secret", version: "1.0.0", day: today, principal: "p1" },
        { pack: "@acme/secret", version: "1.0.0", day: today, principal: "p2" },
        { pack: "@acme/open", version: "1.0.0", day: today, principal: "p1" },
      ];
    };
    expect((await t.run(points)).privateDownloads).toBe("folded");
    expect(await t.stats(priv)).toMatchObject({ fetches_30d: 2 });
    expect(asked).toEqual(["2026-09-22"]);
    t.clock.advance("1h");
    await t.run(points);
    expect(asked[1]).toBe("2026-10-25");
    expect(await t.stats(priv)).toMatchObject({ fetches_30d: 2 });
  });

  it("says private counts are not configured rather than counting them as zero", async () => {
    const t = setup();
    await t.pack("@acme/secret", { visibility: "private" });
    expect((await t.run()).privateDownloads).toBe("not_configured");
    expect(t.d1.rows("select * from rollup_runs where job = 'downloads'")).toEqual([]);
  });
});

describe("what a pack reports about itself", () => {
  it("keeps unknown as null: no counted fetches and no completed scan", async () => {
    const t = setup();
    await t.pack("@acme/x");
    expect(await packFetchStats(t.d1, "@acme/x")).toEqual({ fetches30d: null, fetches7d: null, fetchesPrevious28d: null, distinct30d: null, declaringRepositories: null, computedAt: null });
  });

  it("reads the declaring-repository count from the latest completed scan and null for a pack created after it began", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await t.d1.query("insert into adoption_scans (id, started_at, updated_at, completed_at) values ('s1', '2026-10-27T00:00:00Z', 'x', '2026-10-27T01:00:00Z')");
    await t.d1.query("insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ('s1', '@acme/x', 'a/b', 'a', 'p')");
    await t.d1.query("update packs set created_at = '2026-10-26T00:00:00Z'");
    expect((await packFetchStats(t.d1, "@acme/x")).declaringRepositories).toBe(1);
    await t.d1.query("update packs set created_at = '2026-10-27T00:30:00Z'");
    expect((await packFetchStats(t.d1, "@acme/x")).declaringRepositories).toBeNull();
  });
});

describe("a backlog and a failing read", () => {
  it("drains more objects than one run takes, across runs and days, losing none", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    const total = MAX_OBJECTS_PER_RUN + 50;
    for (let i = 0; i < total; i++) await t.archive("misses", [t.record("@acme/x", "1.0.0", `198.${Math.floor(i / 250)}.${i % 250}.0/24`, START)]);
    const first = await t.run();
    expect(first.objects).toBe(MAX_OBJECTS_PER_RUN);
    t.clock.advance("1d");
    const second = await t.run();
    expect(second.objects).toBe(50);
    expect(await t.stats(id)).toMatchObject({ fetches_30d: total });
    t.clock.advance("1h");
    expect((await t.run()).objects).toBe(0);
  });

  it("still updates public counts when the private read fails, and says so", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    await t.archive("misses", [t.record("@acme/x", "1.0.0", "198.51.100.0/24", START)]);
    const summary = await t.run(async () => {
      throw new Error("analytics down");
    });
    expect(summary).toMatchObject({ privateDownloads: "failed", privateError: "analytics down" });
    expect(await t.stats(id)).toMatchObject({ fetches_30d: 1 });
    expect(t.d1.rows("select * from rollup_runs where job = 'downloads'")).toEqual([]);
  });

  it("does not turn a private pack's window to zero while the private read has not succeeded", async () => {
    const t = setup();
    const priv = await t.pack("@acme/secret", { visibility: "private" });
    const open = await t.pack("@acme/open");
    await t.d1.query("insert into pack_stats (pack_id, fetches_30d, fetches_7d, fetches_prev_28d, computed_at) values (?, 5, 5, 0, 'x'), (?, 5, 5, 0, 'x')", [priv, open]);
    await recomputeStats(t.d1, "2026-10-26", "now");
    expect(await t.stats(open)).toMatchObject({ fetches_30d: 0 });
    expect(await t.stats(priv)).toMatchObject({ fetches_30d: 5 });
    await t.run(async () => []);
    await recomputeStats(t.d1, "2026-10-26", "now");
    expect(await t.stats(priv)).toMatchObject({ fetches_30d: 0 });
  });
});

describe("mismatch reports", () => {
  const report = (over: Partial<Parameters<typeof reportMismatch>[1]> = {}) => ({ pack: "@acme/x", version: "1.0.0", kind: "hash" as const, expected: HASH, observed: OTHER, ...over });
  const deps = (t: ReturnType<typeof setup>) => {
    let n = 0;
    return { d1: t.d1, clock: t.clock, id: () => `r${++n}` };
  };
  const state = async (t: ReturnType<typeof setup>) => String(t.d1.rows("select state from pack_versions")[0]?.state);
  const user = (t: ReturnType<typeof setup>, id: string) => t.d1.query("insert into users (id, handle, created_at) values (?, ?, 'x')", [id, id]);
  /** A reporter with a live read token for the acme scope; `covers: false` is a token that does not reach the pack. */
  const by = (id: string, covers = true) => ({ id, token: `tok-${id}`, covers });
  const anonymous = { id: null, token: null, covers: false };
  const mint = async (t: ReturnType<typeof setup>, id: string) => {
    await t.d1.query("insert or ignore into scope_members (scope_id, user_id, role, created_at) values ('scope-acme', ?, 'owner', 'x')", [id]);
    await t.d1.query(
      "insert into read_tokens (id, user_id, kind, token_hash, hint, scope_id, created_at, expires_at) values (?, ?, 'read', ?, 'abcd', 'scope-acme', 'x', '2099-01-01T00:00:00.000Z')",
      [`tok-${id}`, id, `hash-${id}`],
    );
  };

  it("never quarantines a public version on client reports; two distinct principals open a review", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await user(t, "u1");
    await user(t, "u2");
    await user(t, "u3");
    await mint(t, "u1");
    await mint(t, "u2");
    await mint(t, "u3");
    const d = deps(t);
    expect(await reportMismatch(d, report(), by("u1", false))).toEqual({ recorded: true, principals: 1, quarantined: false, reviewOpened: false });
    expect(await reportMismatch(d, report(), by("u1", false))).toMatchObject({ principals: 1, reviewOpened: false });
    expect(await reportMismatch(d, report(), anonymous)).toMatchObject({ recorded: true, principals: 1 });
    expect(await mismatchesOf(t.d1, "@acme/x")).toEqual([{ version: "1.0.0", reports: 3, principals: 1, anonymous: 1, held: null }]);
    expect(await reportMismatch(d, report(), by("u2", false))).toEqual({ recorded: true, principals: 2, quarantined: false, reviewOpened: true });
    expect(await state(t)).toBe("active");
    expect(await mismatchesOf(t.d1, "@acme/x")).toMatchObject([{ reports: 4, principals: 2, held: "review" }]);
    expect(await reportMismatch(d, report(), by("u2", false))).toMatchObject({ reviewOpened: false });
    expect(t.d1.rows("select * from hash_mismatch_cases")).toHaveLength(1);
    expect(t.d1.rows("select paged_at from hash_mismatch_cases")).toEqual([{ paged_at: null }]);
    // A review that is already open still signals each further distinct principal.
    expect(await reportMismatch(d, report(), by("u3", false))).toMatchObject({ principals: 3, reviewOpened: true });
  });

  it("holds a private version only for two principals whose credentials cover it", async () => {
    const t = setup();
    await t.pack("@acme/secret", { visibility: "private" });
    for (const u of ["u1", "u2", "u3"]) {
      await user(t, u);
      await mint(t, u);
    }
    const d = deps(t);
    const secret = (over = {}) => report({ pack: "@acme/secret", ...over });
    expect(await reportMismatch(d, secret(), by("u3", false))).toEqual({ recorded: false, principals: 0, quarantined: false, reviewOpened: false });
    expect(await reportMismatch(d, secret(), anonymous)).toMatchObject({ recorded: false });
    expect(await reportMismatch(d, secret(), by("u1"))).toMatchObject({ recorded: true, principals: 1, quarantined: false });
    expect(await state(t)).toBe("active");
    expect(await reportMismatch(d, secret(), by("u2"))).toMatchObject({ principals: 2, quarantined: true, reviewOpened: false });
    expect(await state(t)).toBe("quarantined");
    expect(await mismatchesOf(t.d1, "@acme/secret")).toMatchObject([{ reports: 2, principals: 2, held: "reports" }]);
    expect(await reportMismatch(d, secret(), by("u2"))).toMatchObject({ quarantined: false });
    expect(t.d1.rows("select * from hash_mismatch_cases")).toHaveLength(1);
  });

  it("counts only reports that were covering when filed and still are", async () => {
    const t = setup();
    const id = await t.pack("@acme/x");
    for (const u of ["u1", "u2", "u3", "u4"]) {
      await user(t, u);
      await mint(t, u);
    }
    const d = deps(t);
    // Two principals reported while the pack was public: a review, and nothing that counts once it is private.
    await reportMismatch(d, report(), by("u1", false));
    expect(await reportMismatch(d, report(), by("u2", false))).toMatchObject({ reviewOpened: true });
    await t.d1.query("update packs set visibility = 'private' where id = ?", [id]);
    expect(await reportMismatch(d, report(), by("u3"))).toMatchObject({ recorded: true, principals: 1, quarantined: false });
    expect(await state(t)).toBe("active");
    // A covering reporter whose token is revoked stops counting.
    await t.d1.query("update read_tokens set revoked_at = 'x' where id = 'tok-u3'");
    expect(await reportMismatch(d, report(), by("u4"))).toMatchObject({ principals: 1, quarantined: false });
    expect(await state(t)).toBe("active");
    await t.d1.query("update read_tokens set revoked_at = null where id = 'tok-u3'");
    expect(await reportMismatch(d, report(), by("u4"))).toMatchObject({ principals: 2, quarantined: true });
    expect(await state(t)).toBe("quarantined");
  });

  it("does not count reports that expected some other hash or are no mismatch", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await user(t, "u1");
    await mint(t, "u1");
    await user(t, "u2");
    await mint(t, "u2");
    const d = deps(t);
    await reportMismatch(d, report({ expected: OTHER, observed: "c".repeat(64) }), by("u1"));
    expect(await reportMismatch(d, report({ expected: OTHER, observed: "c".repeat(64) }), by("u2"))).toMatchObject({ recorded: true, principals: 0, reviewOpened: false });
    expect(await reportMismatch(d, report({ pack: "@acme/ghost" }), by("u1"))).toMatchObject({ recorded: false });
    expect(await reportMismatch(d, report({ version: "9.9.9" }), by("u1"))).toMatchObject({ recorded: false });
    expect(await reportMismatch(d, report({ observed: HASH }), by("u1"))).toMatchObject({ recorded: false });
    expect(t.d1.rows("select * from hash_mismatch_cases")).toEqual([]);
  });

  it("does not move a version that is already withdrawn", async () => {
    const t = setup();
    await t.pack("@acme/x", { state: "removed" });
    expect(await observeServerMismatch(deps(t), { pack: "@acme/x", version: "1.0.0" })).toEqual({ quarantined: false });
    expect(await state(t)).toBe("removed");
  });

  it("quarantines at once for a mismatch the registry saw itself, and turns an open review into that hold", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await user(t, "u1");
    await mint(t, "u1");
    await user(t, "u2");
    await mint(t, "u2");
    const d = deps(t);
    await reportMismatch(d, report(), by("u1"));
    await reportMismatch(d, report(), by("u2"));
    expect(await observeServerMismatch(d, { pack: "@acme/x", version: "1.0.0" })).toEqual({ quarantined: true });
    expect(await state(t)).toBe("quarantined");
    expect(t.d1.rows("select trigger from hash_mismatch_cases")).toEqual([{ trigger: "server" }]);
  });

  it("drops reports past their retention", async () => {
    const t = setup();
    await t.pack("@acme/x");
    const d = deps(t);
    await reportMismatch(d, report(), anonymous);
    t.clock.advance("91d");
    await reportMismatch(d, report(), anonymous);
    await pruneFetches(t.d1, new Date(t.clock.now()).toISOString().slice(0, 10));
    expect(t.d1.rows("select count(*) as n from hash_mismatch_reports")).toEqual([{ n: 1 }]);
  });
});
