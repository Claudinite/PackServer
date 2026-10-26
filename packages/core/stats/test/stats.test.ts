import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FakeClock, FakeR2 } from "@packserver/ports/fakes";
import { SqliteD1 } from "../../audit/testing";
import {
  HIT_SAMPLE_SCALE, LOG_JOBS, mismatchesOf, observeServerMismatch, packFetchStats, parseLog, pruneFetches, recomputeStats, reportMismatch, runRollup,
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

describe("mismatch reports", () => {
  const report = (over: Partial<Parameters<typeof reportMismatch>[1]> = {}) => ({ pack: "@acme/x", version: "1.0.0", kind: "hash" as const, expected: HASH, observed: OTHER, ...over });
  const deps = (t: ReturnType<typeof setup>) => {
    let n = 0;
    return { d1: t.d1, clock: t.clock, id: () => `r${++n}` };
  };
  const state = async (t: ReturnType<typeof setup>) => String(t.d1.rows("select state from pack_versions")[0]?.state);
  const user = (t: ReturnType<typeof setup>, id: string) =>
    t.d1.query("insert into users (id, handle, created_at) values (?, ?, 'x')", [id, id]);

  it("lists every report and acts only when two distinct authenticated principals have reported", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await user(t, "u1");
    await user(t, "u2");
    const d = deps(t);
    expect(await reportMismatch(d, report(), "u1")).toEqual({ recorded: true, principals: 1, quarantined: false });
    expect(await reportMismatch(d, report(), "u1")).toEqual({ recorded: true, principals: 1, quarantined: false });
    expect(await reportMismatch(d, report(), null)).toEqual({ recorded: true, principals: 1, quarantined: false });
    expect(await state(t)).toBe("active");
    expect(await mismatchesOf(t.d1, "@acme/x")).toEqual([{ version: "1.0.0", reports: 3, principals: 1, anonymous: 1, held: null }]);
    expect(await reportMismatch(d, report(), "u2")).toEqual({ recorded: true, principals: 2, quarantined: true });
    expect(await state(t)).toBe("quarantined");
    expect(await mismatchesOf(t.d1, "@acme/x")).toMatchObject([{ reports: 4, principals: 2, held: "reports" }]);
    expect(await reportMismatch(d, report(), "u2")).toMatchObject({ quarantined: false });
    expect(t.d1.rows("select * from hash_mismatch_cases")).toHaveLength(1);
  });

  it("does not count reports that expected some other hash, name a private pack or are no mismatch", async () => {
    const t = setup();
    await t.pack("@acme/x");
    await t.pack("@acme/secret", { visibility: "private" });
    await user(t, "u1");
    await user(t, "u2");
    const d = deps(t);
    await reportMismatch(d, report({ expected: OTHER, observed: "c".repeat(64) }), "u1");
    expect(await reportMismatch(d, report({ expected: OTHER, observed: "c".repeat(64) }), "u2")).toMatchObject({ recorded: true, principals: 0, quarantined: false });
    expect(await reportMismatch(d, report({ pack: "@acme/secret" }), "u1")).toEqual({ recorded: false, principals: 0, quarantined: false });
    expect(await reportMismatch(d, report({ pack: "@acme/ghost" }), "u1")).toMatchObject({ recorded: false });
    expect(await reportMismatch(d, report({ version: "9.9.9" }), "u1")).toMatchObject({ recorded: false });
    expect(await reportMismatch(d, report({ observed: HASH }), "u1")).toMatchObject({ recorded: false });
    expect(await state(t)).toBe("active");
  });

  it("does not move a version that is already withdrawn", async () => {
    const t = setup();
    await t.pack("@acme/x", { state: "removed" });
    await user(t, "u1");
    await user(t, "u2");
    const d = deps(t);
    await reportMismatch(d, report(), "u1");
    expect(await reportMismatch(d, report(), "u2")).toMatchObject({ principals: 2, quarantined: false });
    expect(await state(t)).toBe("removed");
    expect(await observeServerMismatch(d, { pack: "@acme/x", version: "1.0.0" })).toEqual({ quarantined: false });
  });

  it("quarantines at once for a mismatch the registry saw itself", async () => {
    const t = setup();
    await t.pack("@acme/x");
    expect(await observeServerMismatch(deps(t), { pack: "@acme/x", version: "1.0.0" })).toEqual({ quarantined: true });
    expect(await state(t)).toBe("quarantined");
    expect(t.d1.rows("select trigger from hash_mismatch_cases")).toEqual([{ trigger: "server" }]);
  });
});
