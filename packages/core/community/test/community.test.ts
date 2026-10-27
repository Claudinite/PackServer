import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import {
  checkBurst, drainCommunityNotices, isHeldComment, listComments, postComment, voteOnComment, packsWithFreshStars, hideReview, listReviews, openStarHolds, pruneAuthenticatedDownloads, recomputeCommunity, recordAuthenticatedDownload, refreshPack, star, starState, submitReview, unstar, withPrior,
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
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(28);
    f.advance(7 * DAY + HOUR);
    await recomputeCommunity(f.ports);
    expect(await read()).toMatchObject({ stars: 78 });
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(78);
  });
});

describe("fresh accounts", () => {
  it("are seen as a burst on the day they start to count, by the hourly pass", async () => {
    const f = await fixture();
    // 200 accounts made and used at once: none counts yet, so no click can see the burst.
    const statements = [];
    for (let i = 0; i < 200; i++) {
      statements.push({ sql: "insert into users (id, created_at) values (?, ?)", params: [`new-${i}`, iso(START)] });
      statements.push({ sql: "insert into stars (pack_id, user_id, created_at) values ('pack-gcp', ?, ?)", params: [`new-${i}`, iso(START)] });
    }
    await f.d1.batch(statements);
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(0);
    f.advance(25 * HOUR);
    expect(await recomputeCommunity(f.ports)).toMatchObject({ holds: 1 });
    expect(await openStarHolds(f.d1)).toMatchObject([{ burst_stars: 200 }]);
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(0);
    f.advance(7 * DAY);
    expect((await starState(f.ports, f.pack, undefined)).count).toBe(200);
  });
});

describe("hourly burst candidates", () => {
  it("are only packs with enough fresh counted stars to be a burst", async () => {
    const f = await fixture();
    const at = iso(START - 5 * DAY);
    const statements = [];
    for (let i = 0; i < 60; i++) {
      statements.push({ sql: "insert into packs (id, scope_id, name, visibility, created_at) values (?, 'scope-acme', ?, 'public', ?)", params: [`p${i}`, `p${i}`, at] });
      statements.push({ sql: "insert into users (id, created_at) values (?, ?)", params: [`solo-${i}`, at] });
      statements.push({ sql: "insert into stars (pack_id, user_id, created_at) values (?, ?, ?)", params: [`p${i}`, `solo-${i}`, iso(START - HOUR)] });
    }
    await f.d1.batch(statements);
    await f.stars(50, 2 * HOUR, "crowd");
    expect(await packsWithFreshStars(f.d1, START)).toEqual(["pack-gcp"]);
    const queries: string[] = [];
    const counting = { ...f.ports, d1: { ...f.d1, query: (sql: string, params?: unknown[]) => (queries.push(sql), f.d1.query(sql, params)) } };
    await recomputeCommunity(counting);
    // One candidate pack, so one lookup for an active hold; the 60 single-star packs cost none.
    expect(queries.filter((q) => q.startsWith("select * from star_holds where pack_id"))).toHaveLength(1);
  });
});

describe("verified adoption", () => {
  it("is not given to a review written after the scan stopped finding the declaration", async () => {
    const f = await fixture();
    const a = await f.user("a");
    await f.d1.batch([
      { sql: "insert into identities (id, user_id, provider, provider_user_id, login, created_at) values ('i', ?, 'github', '1', 'Ann', ?)", params: [a, iso(START)] },
      { sql: "insert into adoption_scans (id, started_at, updated_at, completed_at) values ('s1', ?, ?, ?)", params: [iso(START), iso(START), iso(START)] },
      { sql: "insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ('s1', '@acme/gcp', 'ann/app', 'ann', 'x')", params: [] },
    ]);
    const first = await submitReview(f.ports, f.pack, a, { rating: 5, body: "", version: "1.0.0" });
    f.advance(7 * DAY);
    await f.d1.batch([
      { sql: "insert into adoption_scans (id, started_at, updated_at, completed_at) values ('s2', ?, ?, ?)", params: [iso(START + 7 * DAY), iso(START + 7 * DAY), iso(START + 7 * DAY)] },
    ]);
    await f.d1.query("insert into packs (id, scope_id, name, visibility, created_at) values ('pack-b', 'scope-acme', 'b', 'public', ?)", [iso(START)]);
    await f.d1.query("insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values ('vb', 'pack-b', '1.0.0', 'active', 'sha2', 10, 0, 0)");
    const edited = await submitReview(f.ports, f.pack, a, { rating: 4, body: "", version: "1.0.0" });
    const other = await submitReview(f.ports, { id: "pack-b", scope_id: "scope-acme", name: "@acme/b" }, a, { rating: 4, body: "", version: "1.0.0" });
    expect(first).toMatchObject({ review: { verified_adoption: true } });
    expect(edited).toMatchObject({ review: { verified_adoption: true } });
    expect(other).toMatchObject({ review: { verified_adoption: false } });
  });

  it("forgets signed-in downloads past the retention bound", async () => {
    const f = await fixture();
    const a = await f.user("a");
    await recordAuthenticatedDownload(f.d1, { packId: f.pack.id, userId: a, at: iso(START) });
    f.advance(91 * DAY);
    await pruneAuthenticatedDownloads(f.d1, START + 91 * DAY);
    expect((await f.d1.query("select 1 from authenticated_downloads")).rows).toEqual([]);
  });
});

describe("review pages", () => {
  it("walk the list with a cursor, newest edit first", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await submitReview(f.ports, f.pack, await f.user(`u${i}`), { rating: 3, body: `r${i}`, version: "1.0.0" });
      f.advance(1000);
    }
    const one = await listReviews(f.ports, f.pack, undefined, { limit: 2 });
    const two = await listReviews(f.ports, f.pack, undefined, { limit: 2, cursor: one.next_cursor! });
    const three = await listReviews(f.ports, f.pack, undefined, { limit: 2, cursor: two.next_cursor! });
    expect([...one.reviews, ...two.reviews, ...three.reviews].map((r) => r.body)).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(three.next_cursor).toBeNull();
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

describe("section comments", () => {
  const input = { section: "f:RULES.md~top", version: "1.0.0", body: "Name the store." };

  it("hides a net-negative comment from its third day, and only by counted votes", async () => {
    const f = await fixture();
    const [author, a, b, owner, young] = [await f.user("author"), await f.user("a"), await f.user("b"), await f.user("owner", 2 * DAY, "owner"), await f.user("young", HOUR)];
    const posted = await postComment(f.ports, f.pack, author, input, false);
    expect(posted.ok).toBe(true);
    const id = posted.ok ? posted.comment.id : "";
    for (const who of [a, b, owner, young]) await voteOnComment(f.ports, f.pack, who, id, -1);
    const read = async () => (await listComments(f.ports, f.pack, undefined, input.section))[0];

    expect(await read()).toMatchObject({ up: 0, down: 2, hidden: false });
    f.advance(3 * DAY - 1);
    expect((await read())?.hidden).toBe(false);
    f.advance(1);
    expect(await read()).toMatchObject({ hidden: true, down: 3 });
    await voteOnComment(f.ports, f.pack, a, id, 1);
    expect(await read()).toMatchObject({ hidden: true, up: 1, down: 2 });
    await voteOnComment(f.ports, f.pack, b, id, 1);
    expect(await read()).toMatchObject({ hidden: false, up: 2, down: 1 });
  });

  it("refuses a young account and an eleventh comment in a day, and holds a comment for its author", async () => {
    const f = await fixture();
    const [busy, young, other] = [await f.user("busy"), await f.user("young", HOUR), await f.user("other")];
    expect(await postComment(f.ports, f.pack, young, input, false)).toMatchObject({ ok: false, reason: "young_account" });
    for (let i = 0; i < 10; i++) expect((await postComment(f.ports, f.pack, busy, input, false)).ok).toBe(true);
    expect(await postComment(f.ports, f.pack, busy, input, false)).toMatchObject({ ok: false, reason: "daily_limit" });

    const held = await postComment(f.ports, f.pack, other, input, true);
    const id = held.ok ? held.comment.id : "";
    expect((await listComments(f.ports, f.pack, other, input.section)).filter((c) => c.held)).toHaveLength(1);
    expect((await listComments(f.ports, f.pack, busy, input.section)).filter((c) => c.id === id)).toEqual([]);
    expect(await voteOnComment(f.ports, f.pack, busy, id, 1)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await voteOnComment(f.ports, f.pack, other, id, 1)).toMatchObject({ ok: false, reason: "own_comment" });
  });

  it("holds text the publisher-prose checks would not let through", async () => {
    expect(await isHeldComment("Name the secret store here.")).toBe(false);
    expect(await isHeldComment("Use ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6")).toBe(true);
    expect(await isHeldComment("a\u202eb")).toBe(true);
  });
});

describe("comment limits", () => {
  it("caps a person's votes at 200 a day", async () => {
    const f = await fixture();
    const [author, voter] = [await f.user("author"), await f.user("voter")];
    const statements = [];
    for (let i = 0; i < 201; i++) {
      statements.push({ sql: "insert into comments (id, pack_id, section, version, user_id, body, created_at) values (?, 'pack-gcp', 's', '1.0.0', ?, 'x', ?)", params: [`c${i}`, author, iso(START)] });
    }
    for (let i = 0; i < 200; i++) statements.push({ sql: "insert into comment_votes (comment_id, user_id, value, voted_at) values (?, ?, 1, ?)", params: [`c${i}`, voter, iso(START)] });
    for (let i = 0; i < statements.length; i += 50) await f.d1.batch(statements.slice(i, i + 50));
    expect(await voteOnComment(f.ports, f.pack, voter, "c200", 1)).toMatchObject({ ok: false, reason: "daily_limit" });
    f.advance(DAY + 1);
    expect((await voteOnComment(f.ports, f.pack, voter, "c200", 1)).ok).toBe(true);
  });
});
