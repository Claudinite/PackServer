import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import {
  checkBurst, drainCommunityNotices, hideReview, openStarHolds, recomputeCommunity, recordAuthenticatedDownload, refreshPack, star, starState, submitReview, unstar, withPrior,
  type CommunityPorts, type PackRef,
} from "../index.ts";
import { FakeMail } from "@packserver/ports/fakes";

const START = Date.parse("2026-10-23T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

async function fixture() {
  const { d1 } = migratedD1();
  let now = START;
  let n = 0;
  const ports: CommunityPorts = { d1, clock: { now: () => now }, rng: { uuid: () => `id-${++n}`, float: () => 0.5, bytes: (len) => new Uint8Array(len) } };
  const at = iso(START - 30 * DAY);
  const pack: PackRef = { id: "pack-gcp", scope_id: "scope-acme", name: "@acme/gcp" };
  await d1.batch([
    { sql: "insert into scopes (id, name, kind, state, created_at) values ('scope-acme', 'acme', 'org', 'active', ?)", params: [at] },
    { sql: "insert into packs (id, scope_id, name, visibility, created_at) values ('pack-gcp', 'scope-acme', 'gcp', 'public', ?)", params: [at] },
    { sql: "insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values ('v1', 'pack-gcp', '1.0.0', 'active', 'sha', 10, 0, 0)", params: [] },
  ]);
  const user = async (id: string, ageMs = 2 * DAY, role?: string) => {
    await d1.batch([
      { sql: "insert into users (id, handle, created_at) values (?, ?, ?)", params: [id, id, iso(START - ageMs)] },
      { sql: "insert into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)", params: [id, `${id}@example.test`, at] },
      ...(role ? [{ sql: "insert into scope_members (scope_id, user_id, role, created_at) values ('scope-acme', ?, ?, ?)", params: [id, role, at] }] : []),
    ]);
    return id;
  };
  /** Counted stars placed `agoMs` before the clock, by accounts made up for the purpose. */
  const stars = async (count: number, agoMs: number, label: string) => {
    const statements = [];
    for (let i = 0; i < count; i++) {
      const id = `${label}-${i}`;
      statements.push({ sql: "insert into users (id, created_at) values (?, ?)", params: [id, iso(START - 5 * DAY)] });
      statements.push({ sql: "insert into stars (pack_id, user_id, created_at) values ('pack-gcp', ?, ?)", params: [id, iso(now - agoMs)] });
    }
    await d1.batch(statements);
  };
  return { d1, ports, pack, user, stars, advance: (ms: number) => void (now += ms) };
}

describe("rating prior", () => {
  it("counts the catalogue mean as ten ratings", () => {
    expect(withPrior(4, 5, 1)).toBeCloseTo(45 / 11, 9);
    expect(withPrior(4, 180, 40)).toBeCloseTo(4.4, 9);
    expect(withPrior(4, 0, 0)).toBe(4);
  });

  it("weighs a review without verified adoption at half in the ranking figure only", async () => {
    const f = await fixture();
    const [a, b] = [await f.user("a"), await f.user("b")];
    await recordAuthenticatedDownload(f.d1, { packId: f.pack.id, userId: a, at: iso(START) });
    await submitReview(f.ports, f.pack, a, { rating: 5, body: "", version: "1.0.0" });
    await submitReview(f.ports, f.pack, b, { rating: 1, body: "", version: "1.0.0" });
    const { mean } = await recomputeCommunity(f.ports);
    expect(mean).toBe(3);
    const { rows } = await f.d1.query("select shown, ranked, verified_count from pack_ratings");
    expect(rows[0]!.shown).toBeCloseTo((30 + 6) / 12, 9);
    expect(rows[0]!.ranked).toBeCloseTo((30 + 5 + 0.5) / 11.5, 9);
    expect(rows[0]!.verified_count).toBe(1);
  });
});

describe("star counting", () => {
  it("leaves out accounts under a day old and anyone with a role in the scope, until they qualify", async () => {
    const f = await fixture();
    const [young, owner, outsider] = [await f.user("young", 23 * HOUR), await f.user("owner", 5 * DAY, "owner"), await f.user("outsider")];
    for (const who of [young, owner, outsider]) await star(f.ports, f.pack, who);
    expect(await starState(f.ports, f.pack, young)).toEqual({ count: 1, starred: true });
    f.advance(HOUR);
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(2);
    await unstar(f.ports, f.pack, outsider);
    expect((await starState(f.ports, f.pack, outsider))).toEqual({ count: 1, starred: false });
  });
});

describe("anomaly hold", () => {
  it("needs 50 counted stars in 24 hours and strictly more than ten times the 7-day average", async () => {
    const f = await fixture();
    await f.stars(28, 3 * DAY, "before");
    await f.stars(49, 2 * HOUR, "burst");
    expect(await checkBurst(f.ports, f.pack.id)).toBeNull();
    await f.stars(1, HOUR, "last");
    const hold = await checkBurst(f.ports, f.pack.id);
    expect(hold).toMatchObject({ burst_stars: 50, daily_average: 4 });
    expect(await checkBurst(f.ports, f.pack.id)).toBeNull();
    expect(await openStarHolds(f.d1)).toHaveLength(1);
  });

  it("is not triggered when 50 is not more than ten times the average", async () => {
    const f = await fixture();
    await f.stars(42, 3 * DAY, "before");
    await f.stars(50, 2 * HOUR, "burst");
    expect(await checkBurst(f.ports, f.pack.id)).toBeNull();
  });

  it("keeps the burst out of the ranking figures for 7 days and removes no star", async () => {
    const f = await fixture();
    await f.stars(28, 3 * DAY, "before");
    await f.stars(50, 2 * HOUR, "burst");
    await checkBurst(f.ports, f.pack.id);
    await refreshPack(f.ports, f.pack.id);
    const read = async () => (await f.d1.query("select stars, stars_7d from pack_stats where pack_id = 'pack-gcp'")).rows[0];
    expect(await read()).toMatchObject({ stars: 28, stars_7d: 28 });
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(78);
    f.advance(7 * DAY + HOUR);
    await recomputeCommunity(f.ports);
    expect(await read()).toMatchObject({ stars: 78 });
  });
});

describe("reviews", () => {
  it("keeps the verified mark when the review is edited", async () => {
    const f = await fixture();
    const a = await f.user("a");
    await recordAuthenticatedDownload(f.d1, { packId: f.pack.id, userId: a, at: iso(START) });
    const first = await submitReview(f.ports, f.pack, a, { rating: 3, body: "ok", version: "1.0.0" });
    await f.d1.query("delete from authenticated_downloads");
    const second = await submitReview(f.ports, f.pack, a, { rating: 4, body: "better", version: "1.0.0" });
    expect(first).toMatchObject({ ok: true, created: true, review: { verified_adoption: true } });
    expect(second).toMatchObject({ ok: true, created: false, review: { rating: 4, verified_adoption: true } });
  });

  it("refuses an unknown version, and hiding queues the reason for the author", async () => {
    const f = await fixture();
    const a = await f.user("a");
    expect(await submitReview(f.ports, f.pack, a, { rating: 3, body: "", version: "9.9.9" })).toMatchObject({ ok: false, reason: "unknown_version" });
    const made = await submitReview(f.ports, f.pack, a, { rating: 3, body: "x", version: "1.0.0" });
    if (!made.ok) throw new Error(made.message);
    expect(await hideReview(f.ports, made.review.id, "Spam")).toEqual({ ok: true });
    expect(await hideReview(f.ports, made.review.id, "Again")).toEqual({ ok: false, reason: "hidden" });
    const mail = new FakeMail();
    expect(await drainCommunityNotices(f.ports, { mail, siteOrigin: "https://registry.example" })).toEqual({ sent: 1, skipped: 0 });
    expect(mail.sent[0]?.text).toContain("Spam");
    expect((await f.d1.query("select rating from pack_stats where pack_id = 'pack-gcp'")).rows[0]!.rating).toBeNull();
  });
});
