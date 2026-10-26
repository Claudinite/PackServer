import { describe, expect, it } from "vitest";
import { FakeClock, FakeKV, FakeVectorIndex } from "@packserver/ports/fakes";
import type { Embedder } from "@packserver/ports";
import { SqliteD1 } from "../audit/testing";
import {
  SearchConfigError,
  SearchRequestError,
  SearchUnavailableError,
  applyIndex,
  applyRemoval,
  indexPlan,
  listCategories,
  search,
  trending,
  type Listing,
  type SearchConfig,
  type SearchPorts,
} from "./index";

const DIMS = 64;
const CONFIG: SearchConfig = { embeddingModel: "test-model", embeddingDimensions: DIMS };
const DAY = 86_400_000;

/** A recorded meaning table of one-hot concepts; any other text gets a deterministic pseudo-random unit vector. */
class TableEmbedder implements Embedder {
  readonly model = "test-model";
  readonly dimensions = DIMS;
  readonly table = new Map<string, number>();
  spent = false;
  calls = 0;
  async embed(texts: string[]) {
    if (this.spent) throw new Error("budget spent");
    this.calls += texts.length;
    return texts.map((t) => {
      const axis = this.table.get(t);
      if (axis !== undefined) return Array.from({ length: DIMS }, (_, i) => (i === axis ? 1 : 0));
      let seed = [...t].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
      const raw = Array.from({ length: DIMS }, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5);
      const norm = Math.sqrt(raw.reduce((n, x) => n + x * x, 0));
      return raw.map((x) => x / norm);
    });
  }
}

function setup() {
  const db = new SqliteD1();
  const clock = new FakeClock();
  const embedder = new TableEmbedder();
  const vectors = new FakeVectorIndex();
  const ports: SearchPorts = { d1: db, embedder, vectors, kv: new FakeKV(clock), clock };
  let n = 0;

  async function pack(name: string, over: Partial<Listing> & { scope?: string; scopeKind?: string; visibility?: string; states?: string[]; verified?: boolean; domain?: string | null; promotedDaysAgo?: number; minEngine?: string | null; indexed?: boolean; version?: string } = {}) {
    n++;
    const [scopeName, packName] = name.slice(1).split("/") as [string, string];
    const scopeId = `scope-${scopeName}`;
    const packId = `pack-${n}`;
    const kind = over.scopeKind ?? "org";
    await db.query("INSERT OR IGNORE INTO scopes (id, name, kind, state, verified_domain, created_at) VALUES (?, ?, 'org', 'active', ?, 'x')", [scopeId, scopeName, over.domain ?? null]);
    if (kind !== "org") {
      db.db.exec("pragma ignore_check_constraints = on");
      await db.query("UPDATE scopes SET kind = ? WHERE id = ?", [kind, scopeId]);
      db.db.exec("pragma ignore_check_constraints = off");
    }
    await db.query("INSERT INTO packs (id, scope_id, name, visibility, created_at) VALUES (?, ?, ?, ?, 'x')", [packId, scopeId, packName, over.visibility ?? "public"]);
    for (const [i, state] of (over.states ?? ["active"]).entries()) {
      await db.query(
        "INSERT INTO pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, verified_domain, source_verified, min_engine_version, score) VALUES (?, ?, ?, ?, 'h', 1, ?, ?, ?, 0, ?, ?)",
        [`v-${n}-${i}`, packId, over.version ?? `1.${i}.0`, state, new Date(clock.now()).toISOString(), over.verified ? 1 : 0, over.domain ?? null, over.minEngine ?? null, over.score ?? 70],
      );
    }
    const listing: Listing = {
      packId,
      name,
      scopeKind: kind,
      pitch: "A pack",
      category: "other",
      tags: [],
      skills: [],
      stored: { inventory_counts: { rules: 1 }, context_cost: 100, verdict: "pass", repository: null, score_parts: [] },
      hasRepository: false,
      promotedAt: new Date(clock.now() - (over.promotedDaysAgo ?? 200) * DAY).toISOString(),
      newest: { version: "1.0.0", publishedAt: new Date(clock.now()).toISOString(), minEngineVersion: null },
      verification: { verified: over.verified ?? false, domain: over.domain ?? null, githubOrg: null },
      score: over.score ?? 70,
      stars: 0,
      rating: null,
      ...over,
    };
    if (over.indexed !== false) await applyIndex({ d1: db, embedder, vectors }, listing, new Date(clock.now()).toISOString());
    return { packId, listing };
  }
  const stats = (packId: string, s: Partial<Record<"fetches_30d" | "fetches_7d" | "fetches_prev_28d" | "stars" | "stars_7d" | "stars_prev_28d" | "rating", number>>) =>
    db.query(
      "INSERT OR REPLACE INTO pack_stats (pack_id, fetches_30d, fetches_7d, fetches_prev_28d, stars, stars_7d, stars_prev_28d, rating, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x')",
      [packId, s.fetches_30d ?? 0, s.fetches_7d ?? 0, s.fetches_prev_28d ?? 0, s.stars ?? 0, s.stars_7d ?? 0, s.stars_prev_28d ?? 0, s.rating ?? null],
    );
  const ids = async (request: Parameters<typeof search>[2]) => (await search(ports, CONFIG, request)).cards.map((c) => c.id);
  return { db, clock, embedder, vectors, ports, pack, stats, ids };
}

describe("lexical search", () => {
  it("weights a name above a pitch above a skill description", async () => {
    const t = setup();
    await t.pack("@a/in-skill", { skills: [{ name: "s", description: "terraform helper" }], score: 70 });
    await t.pack("@a/in-pitch", { pitch: "terraform helper", score: 70 });
    await t.pack("@a/terraform", { score: 70 });
    expect(await t.ids({ query: "terraform" })).toEqual(["@a/terraform", "@a/in-pitch", "@a/in-skill"]);
  });

  it("requires every word, matches a prefix and survives operator text", async () => {
    const t = setup();
    await t.pack("@a/run", { pitch: "Deploy to Google Cloud Run", tags: ["gcp"] });
    await t.pack("@a/other", { pitch: "Deploy to Fly" });
    expect(await t.ids({ query: "deploy gcp cloud" })).toEqual(["@a/run"]);
    expect(await t.ids({ query: "depl" })).toHaveLength(2);
    expect(await t.ids({ query: 'deploy" OR * NEAR(' })).toEqual(expect.any(Array));
  });

  it("matches tags and stems words", async () => {
    const t = setup();
    await t.pack("@a/x", { pitch: "Runs containers", tags: ["cloudrun", "serverless"] });
    expect(await t.ids({ query: "cloudrun" })).toEqual(["@a/x"]);
    expect(await t.ids({ query: "container" })).toEqual(["@a/x"]);
  });

  it("follows a pack's new listing and keeps its first promotion time", async () => {
    const t = setup();
    const { listing } = await t.pack("@a/moves", { pitch: "old wording", promotedDaysAgo: 100 });
    await applyIndex({ d1: t.db, embedder: t.embedder, vectors: t.vectors }, { ...listing, pitch: "fresh wording", promotedAt: new Date(t.clock.now()).toISOString() }, "later");
    expect(await t.ids({ query: "old" })).toEqual([]);
    expect(await t.ids({ query: "fresh" })).toEqual(["@a/moves"]);
    const recent = await t.db.query("SELECT promoted_at FROM recent WHERE pack_id = ?", [listing.packId]);
    expect(Date.parse(String(recent.rows[0]?.promoted_at))).toBe(Date.parse(listing.promotedAt));
    expect(t.vectors.items.size).toBe(1);
  });

  it("stops finding a pack once its row is removed", async () => {
    const t = setup();
    const { packId } = await t.pack("@a/gone", { pitch: "findable thing" });
    expect(await t.ids({ query: "findable" })).toEqual(["@a/gone"]);
    await applyRemoval({ d1: t.db, vectors: t.vectors }, packId);
    expect(await t.ids({ query: "findable" })).toEqual([]);
    expect(t.vectors.items.size).toBe(0);
  });
});

describe("what is searchable", () => {
  it("leaves out private packs, synthetic scopes and packs with no eligible version", async () => {
    const t = setup();
    await t.pack("@a/public", { pitch: "needle" });
    await t.pack("@a/private", { pitch: "needle", visibility: "private" });
    await t.pack("@probe/p", { pitch: "needle", scopeKind: "synthetic", indexed: false });
    await t.pack("@a/yanked", { pitch: "needle", states: ["yanked"] });
    await t.pack("@a/pending", { pitch: "needle", states: ["pending"] });
    expect(await t.ids({ query: "needle" })).toEqual(["@a/public"]);
    expect(await t.ids({})).toEqual(["@a/public"]);
  });

  it("filters a synthetic scope out of the query even if its row is in the index", async () => {
    const t = setup();
    const { listing } = await t.pack("@probe/p", { pitch: "needle", scopeKind: "synthetic", indexed: false });
    const real = { ...listing, scopeKind: "org" };
    const plan = indexPlan(real, "now");
    await t.db.batch(plan?.statements ?? []);
    expect(await t.ids({ query: "needle" })).toEqual([]);
    expect(await t.ids({})).toEqual([]);
  });

  it("shows the newest eligible version's facts", async () => {
    const t = setup();
    await t.pack("@a/v", { states: ["active", "yanked", "deprecated"], pitch: "versions" });
    const [card] = (await search(t.ports, CONFIG, { query: "versions" })).cards;
    expect(card?.newest_eligible?.version).toBe("1.2.0");
  });

  it("refuses a category outside the fixed list and plans nothing for a synthetic scope", () => {
    const base = { packId: "p" } as Listing;
    expect(() => indexPlan({ ...base, scopeKind: "org", category: "made-up" }, "now")).toThrow(/not one of/);
    expect(indexPlan({ ...base, scopeKind: "synthetic", category: "made-up" }, "now")).toBeNull();
  });
});

describe("filters", () => {
  it("narrows by category, part, repository and verification", async () => {
    const t = setup();
    await t.pack("@a/r", { pitch: "cloud thing", category: "cloud", stored: { inventory_counts: { rules: 1, skills: 2 }, context_cost: 1, verdict: "pass", repository: "https://github.com/a/r", score_parts: [] }, hasRepository: true, verified: true, domain: "a.test" });
    await t.pack("@b/k", { pitch: "cloud thing", category: "data", stored: { inventory_counts: { checks: 1 }, context_cost: 1, verdict: "pass", repository: null, score_parts: [] } });
    expect(await t.ids({ query: "cloud" })).toHaveLength(2);
    expect(await t.ids({ query: "cloud", category: "cloud" })).toEqual(["@a/r"]);
    expect(await t.ids({ query: "cloud", part: "skills" })).toEqual(["@a/r"]);
    expect(await t.ids({ query: "cloud", part: "checks" })).toEqual(["@b/k"]);
    expect(await t.ids({ query: "cloud", has_repository: true })).toEqual(["@a/r"]);
    expect(await t.ids({ query: "cloud", verified_only: true })).toEqual(["@a/r"]);
    expect(await t.ids({ query: "cloud", verified_domains: ["A.test"] })).toEqual(["@a/r"]);
    expect(await t.ids({ query: "cloud", verified_domains: ["other.test"] })).toEqual([]);
  });

  it("names the tool that lists valid categories", async () => {
    const t = setup();
    await expect(search(t.ports, CONFIG, { category: "made-up" })).rejects.toMatchObject({ reason: "unknown_category", suggestion: "list_categories" });
    await expect(search(t.ports, CONFIG, { part: "nope" })).rejects.toBeInstanceOf(SearchRequestError);
  });

  it("counts public packs per fixed category", async () => {
    const t = setup();
    await t.pack("@a/x", { category: "cloud" });
    await t.pack("@a/y", { category: "cloud" });
    await t.pack("@a/z", { category: "cloud", visibility: "private" });
    const counts = await listCategories(t.db);
    expect(counts.find((c) => c.category === "cloud")?.count).toBe(2);
    expect(counts.map((c) => c.category)).toHaveLength(10);
  });
});

describe("ranking", () => {
  it("orders equally relevant packs by score and by a named signal on request", async () => {
    const t = setup();
    const low = await t.pack("@a/low", { pitch: "same words", score: 40 });
    const high = await t.pack("@a/high", { pitch: "same words", score: 85 });
    await t.stats(low.packId, { stars: 500, rating: 5, fetches_30d: 9000 });
    await t.stats(high.packId, { stars: 1, rating: 3, fetches_30d: 1 });
    expect(await t.ids({ query: "same words" })).toEqual(["@a/high", "@a/low"]);
    expect(await t.ids({})).toEqual(["@a/high", "@a/low"]);
    for (const sort of ["stars", "rating", "fetches"] as const) expect(await t.ids({ sort })).toEqual(["@a/low", "@a/high"]);
    expect(await t.ids({ sort: "recent" })).toHaveLength(2);
    const [first] = (await search(t.ports, CONFIG, { query: "same words" })).cards;
    expect(first).toMatchObject({ stars: 1, score: 85 });
  });

  it("orders by recency", async () => {
    const t = setup();
    await t.pack("@a/old", { promotedDaysAgo: 100 });
    await t.pack("@a/new", { promotedDaysAgo: 1 });
    expect(await t.ids({ sort: "recent" })).toEqual(["@a/new", "@a/old"]);
  });

  it("lets relevance lead and a category word lift a pack", async () => {
    const t = setup();
    await t.pack("@a/exact", { pitch: "terraform", score: 50 });
    await t.pack("@a/partial", { pitch: "terraform", skills: [{ name: "n", description: "x" }], score: 52 });
    expect((await t.ids({ query: "terraform" }))[0]).toBeDefined();
    await t.pack("@a/cat", { pitch: "widgets", category: "testing", score: 50 });
    await t.pack("@a/nocat", { pitch: "widgets testing", category: "docs", score: 50 });
    expect((await t.ids({ query: "testing" }))[0]).toBe("@a/cat");
  });

  it("ranks a pack needing a newer engine lower", async () => {
    const t = setup();
    await t.pack("@a/new-engine", { pitch: "same", score: 90, minEngine: "2.0.0" });
    await t.pack("@a/old-engine", { pitch: "same", score: 70, minEngine: "1.0.0" });
    expect(await t.ids({ query: "same" })).toEqual(["@a/new-engine", "@a/old-engine"]);
    expect(await t.ids({ query: "same", engine_version: "1.5.0" })).toEqual(["@a/old-engine", "@a/new-engine"]);
  });

  it("puts demoted packs below every other and restores them when cleared", async () => {
    const t = setup();
    const top = await t.pack("@a/top", { pitch: "x", score: 95 });
    await t.pack("@a/mid", { pitch: "x", score: 60 });
    await t.pack("@a/last", { pitch: "x", score: 20 });
    for (const reason of ["advisory", "failed_validation", "abuse_hold"]) {
      await t.db.query("UPDATE pack_search SET demotion = ? WHERE pack_id = ?", [reason, top.packId]);
      expect(await t.ids({ query: "x" })).toEqual(["@a/mid", "@a/last", "@a/top"]);
      expect(await t.ids({ sort: "stars" })).toEqual(["@a/mid", "@a/last", "@a/top"]);
    }
    await t.db.query("UPDATE pack_search SET demotion = NULL WHERE pack_id = ?", [top.packId]);
    expect((await t.ids({ query: "x" }))[0]).toBe("@a/top");
  });
});

describe("exploration slots", () => {
  async function catalogue(size: number) {
    const t = setup();
    const established = size - 9;
    for (let i = 0; i < established; i++) await t.pack(`@e/p${String(i).padStart(2, "0")}`, { score: 95 - i, category: "cloud" });
    for (let i = 0; i < 9; i++) await t.pack(`@f/p${i}`, { score: 60 + (i % 6), category: "cloud", promotedDaysAgo: 3 });
    return t;
  }

  it("is absent below fifty public packs", async () => {
    const t = await catalogue(49);
    const cards = (await search(t.ports, CONFIG, { category: "cloud", limit: 20 })).cards;
    expect(cards.map((c) => c.score)).toEqual([...cards.map((c) => c.score)].sort((a, b) => b - a));
    expect(cards.some((c) => c.exploration)).toBe(false);
  });

  it("fills positions 10 and 20 with fresh packs of score 60 or more from below them", async () => {
    const t = await catalogue(50);
    await t.pack("@f/low", { score: 59, promotedDaysAgo: 2, category: "cloud" });
    await t.pack("@f/old", { score: 80, promotedDaysAgo: 91, category: "cloud" });
    const cards = (await search(t.ports, CONFIG, { category: "cloud", limit: 30 })).cards;
    const slots = cards.flatMap((c, i) => (c.exploration ? [i + 1] : []));
    expect(slots).toEqual([10, 20, 30]);
    for (const slot of slots) expect(cards[slot - 1]?.id.startsWith("@f/p")).toBe(true);
    expect(cards.slice(0, 30).some((c) => c.id === "@f/low" || (c.id === "@f/old" && c.exploration))).toBe(false);
    const plain = cards.filter((c) => !c.exploration).map((c) => c.score);
    expect(plain).toEqual([...plain].sort((a, b) => b - a).filter((s, _, all) => all.includes(s)));
  });

  it("does not apply to a query's results, only to browse", async () => {
    const t = await catalogue(50);
    const cards = (await search(t.ports, CONFIG, { query: "a pack", limit: 30 })).cards;
    expect(cards.some((c) => c.exploration)).toBe(false);
  });

  it("does not apply to an explicit sort", async () => {
    const t = await catalogue(50);
    const cards = (await search(t.ports, CONFIG, { sort: "stars", limit: 30 })).cards;
    expect(cards.some((c) => c.exploration)).toBe(false);
  });
});

describe("meaning", () => {
  async function meaningCase() {
    const t = setup();
    const r = await t.pack("@a/r", { pitch: "Run containers on Google Cloud", category: "cloud", indexed: false });
    t.embedder.table.set("deploy to gcp cloud run", 3);
    t.embedder.table.set("Run containers on Google Cloud\ncloud\n", 3);
    await applyIndex({ d1: t.db, embedder: t.embedder, vectors: t.vectors }, r.listing, "now");
    await t.pack("@a/k", { pitch: "Cloud Run deploy helper for GCP", category: "data" });
    return t;
  }

  it("finds a pack by meaning and shows the keyword match too", async () => {
    const t = await meaningCase();
    const out = await search(t.ports, CONFIG, { query: "Deploy to GCP Cloud Run" });
    expect(out.degraded).toBe(false);
    expect(out.cards.map((c) => c.id).sort()).toEqual(["@a/k", "@a/r"]);
  });

  it("answers by keyword alone, degraded, when the model cannot be used", async () => {
    const t = await meaningCase();
    t.embedder.spent = true;
    const out = await search(t.ports, CONFIG, { query: "gcp cloud run deploy" });
    expect(out.degraded).toBe(true);
    expect(out.cards.map((c) => c.id)).toEqual(["@a/k"]);
  });

  it("embeds a repeated query once and a browse never", async () => {
    const t = await meaningCase();
    const before = t.embedder.calls;
    await search(t.ports, CONFIG, { query: "Deploy to GCP Cloud Run" });
    await search(t.ports, CONFIG, { query: "  deploy to gcp  cloud run " });
    expect(t.embedder.calls - before).toBe(1);
    await search(t.ports, CONFIG, {});
    expect(t.embedder.calls - before).toBe(1);
    t.embedder.spent = true;
    expect((await search(t.ports, CONFIG, { query: "deploy to gcp cloud run" })).degraded).toBe(false);
  });

  it("never returns a pack whose vector lingers after it left", async () => {
    const t = await meaningCase();
    const r = await t.db.query("SELECT id FROM packs WHERE name = 'r'");
    await t.db.query("UPDATE packs SET visibility = 'private' WHERE id = ?", [r.rows[0]?.id]);
    expect(t.vectors.items.size).toBe(2);
    expect((await search(t.ports, CONFIG, { query: "deploy to gcp cloud run" })).cards.map((c) => c.id)).toEqual(["@a/k"]);
  });

  it("answers nothing when the database is down, so a leftover vector can never leak a private or synthetic pack", async () => {
    const t = await meaningCase();
    const r = await t.db.query("SELECT id FROM packs WHERE name = 'r'");
    await t.db.query("UPDATE packs SET visibility = 'private' WHERE id = ?", [r.rows[0]?.id]);
    expect(t.vectors.items.size).toBe(2);
    t.db.down = true;
    await expect(search(t.ports, CONFIG, { query: "deploy to gcp cloud run" })).rejects.toBeInstanceOf(SearchUnavailableError);
  });

  it("removes the vector before the rows, and fails the removal if the vector stays", async () => {
    const t = await meaningCase();
    const r = await t.db.query("SELECT id FROM packs WHERE name = 'r'");
    const id = String(r.rows[0]?.id);
    const stuck = { deleteByIds: async () => { throw new Error("vectorize down"); } };
    await expect(applyRemoval({ d1: t.db, vectors: stuck }, id)).rejects.toThrow(/vectorize down/);
    expect((await t.db.query("SELECT 1 FROM pack_search WHERE pack_id = ?", [id])).rows).toHaveLength(1);
    await applyRemoval({ d1: t.db, vectors: t.vectors }, id);
    expect(t.vectors.items.has(id)).toBe(false);
  });
});

describe("configuration", () => {
  it("refuses an embedder that is not the configured model", async () => {
    const t = setup();
    await expect(search(t.ports, { ...CONFIG, embeddingModel: "other" }, {})).rejects.toBeInstanceOf(SearchConfigError);
    await expect(search(t.ports, { ...CONFIG, embeddingDimensions: 1024 }, {})).rejects.toBeInstanceOf(SearchConfigError);
    await expect(search(t.ports, { embeddingModel: "", embeddingDimensions: Number.NaN }, {})).rejects.toBeInstanceOf(SearchConfigError);
  });
});

describe("trending", () => {
  it("ranks by growth and hides a pack under either floor", async () => {
    const t = setup();
    const g = await t.pack("@a/g");
    const s = await t.pack("@a/s");
    const f = await t.pack("@a/f");
    const tt = await t.pack("@a/t");
    expect(await trending(t.db)).toEqual([]);
    await t.stats(g.packId, { fetches_7d: 100, fetches_prev_28d: 10, stars_7d: 6, stars_prev_28d: 1 });
    await t.stats(s.packId, { fetches_7d: 1010, fetches_prev_28d: 1000, stars_7d: 51, stars_prev_28d: 50 });
    await t.stats(f.packId, { fetches_7d: 49, stars_7d: 20 });
    await t.stats(tt.packId, { fetches_7d: 100, stars_7d: 4 });
    expect((await trending(t.db)).map((c) => c.id)).toEqual(["@a/g", "@a/s"]);
    await t.stats(f.packId, { fetches_7d: 50, stars_7d: 20 });
    await t.stats(tt.packId, { fetches_7d: 100, stars_7d: 5 });
    expect((await trending(t.db)).map((c) => c.id).sort()).toEqual(["@a/f", "@a/g", "@a/s", "@a/t"]);
  });
});
