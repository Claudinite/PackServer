import { compareVersions } from "@packserver/core/index";
import { ListingRefused, SEARCH_PARTS, embeddingText, indexPlan, normalizeQuery, removalPlan, type Listing, type SearchPart } from "@packserver/core/search";
import type { Driver } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError } from "../errors";
import { Refusal } from "../outcomes";
import type { PackHandle } from "../packs";

export interface ListingSeed {
  pitch: string;
  /** One of the fixed categories; anything else is refused as validation refuses it. */
  category?: string;
  tags?: string[];
  skills?: Array<{ name: string; description: string }>;
  parts?: SearchPart[];
  /** A linked public repository; absent means none. */
  repository?: string;
  score?: number;
  /** How long ago the pack was first promoted, e.g. `"10d"`. */
  promoted?: string;
  /** Queries the embedder reads as meaning what this pack means. */
  nearTo?: string[];
}

export interface SignalsSeed {
  stars?: number;
  rating?: number;
  fetches?: number;
  fetchesLast7d?: number;
  fetchesBefore?: number;
  starsLast7d?: number;
  starsBefore?: number;
}

export interface Filters {
  category?: string;
  part?: string;
  verifiedPublisher?: boolean;
  verifiedDomains?: string[];
  hasRepository?: boolean;
  sort?: "score" | "stars" | "rating" | "recent" | "fetches";
  limit?: number;
  offset?: number;
  engine?: string;
}

export interface ResultCard {
  id: string;
  pitch: string;
  stars: number;
  rating: number | null;
  score: number;
  category: string;
  verified: boolean;
  exploration?: true;
  [field: string]: unknown;
}
export interface Results {
  ids: string[];
  cards: ResultCard[];
  degraded: boolean;
  /** One-based positions held by exploration slots. */
  slots: number[];
}

/** Search as the site and the search service answer it, and the seeding that stands in for promotion until it lands. */
export interface SearchModule {
  search: {
    /** Indexes the pack as promotion will; refused when the category is outside the fixed list. */
    list(pack: PackHandle, seed: ListingSeed): Promise<void | Refusal>;
    /**
     * Many public packs at once for scenarios that count the catalogue: each has one active version and a search listing
     * and no stored objects, which search never reads. Names are returned as given.
     */
    fill(packs: Array<{ name: string } & ListingSeed>): Promise<string[]>;
    signals(pack: PackHandle, seed: SignalsSeed): Promise<void>;
    demote(pack: PackHandle, reason: "advisory" | "failed_validation" | "abuse_hold" | null): Promise<void>;
    /** The pack leaves search; `vectorLeft` keeps its vector, as a lagging index would. */
    unlist(pack: PackHandle, how: "private" | "removed", o?: { vectorLeft?: true }): Promise<void>;
    /** The pack's scope becomes the synthetic tenant, whatever the index already holds. */
    synthetic(pack: PackHandle): Promise<void>;
    /** The site's search and browse. */
    site(query?: string, filters?: Filters): Promise<Results>;
    /** The search service the MCP tools call. */
    service(query?: string, filters?: Filters): Promise<Results>;
    categories(): Promise<Array<{ category: string; count: number }>>;
    trending(): Promise<string[]>;
    /** Packs that have a vector in the index. */
    vectors(): Promise<string[]>;
    /** The day's model budget is spent (or restored). */
    budget(spent: boolean): Promise<void>;
    /** How many texts the embedder has been asked to embed since the scenario began. */
    embedded(): Promise<number>;
  };
}

const DURATION = /^(\d+)(d|h|m)$/;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
/** The Workers read the system clock, so the seed is dated against it and not the fake clock. */
const ago = (duration: string): string => {
  const m = DURATION.exec(duration);
  if (!m) throw new InfrastructureError(`not a duration: ${duration} (use e.g. 10d)`);
  return new Date(Date.now() - Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]).toISOString();
};

/** A unit vector on an axis chosen by name: texts told to share a concept get the same one. */
function conceptVector(concept: string, width: number): number[] {
  let h = 2166136261;
  for (const ch of concept) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const axis = (h >>> 0) % width;
  return Array.from({ length: width }, (_, i) => (i === axis ? 1 : 0));
}
const WIDTH = 1024;

type Row = Record<string, unknown>;

export function createSearch(driver: Driver, aliases: Aliases): SearchModule {
  const fakes = () => {
    if (!driver.fakes?.workers.ai || !driver.fakes.workers.vectorize) throw new InfrastructureError(`the ${driver.kind} driver has no fake embedder or vector index`);
    return { ai: driver.fakes.workers.ai, vectorize: driver.fakes.workers.vectorize };
  };
  const storage = async () => {
    if (!driver.storage || !driver.capabilities.has("storage")) throw new InfrastructureError(`the ${driver.kind} driver cannot seed search: it has no storage seam`);
    return driver.storage();
  };
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    const { db } = await storage();
    const stmt = db.prepare(sql).bind(...params) as unknown as { all(): Promise<{ results: Row[] }> };
    return (await stmt.all()).results;
  };
  const run = async (statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> => {
    const { db } = await storage();
    await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))));
  };

  async function identify(pack: PackHandle): Promise<{ packId: string; scopeKind: string; versions: Row[] }> {
    const [scope, name] = pack.systemName.slice(1).split("/") as [string, string];
    const found = await rows("SELECT p.id AS id, s.kind AS kind FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?", [scope, name]);
    const row = found[0];
    if (!row) throw new InfrastructureError(`${pack.name} was not created in this scenario`);
    const versions = await rows("SELECT version, state, published_at, verified, verified_domain, verified_github_org, min_engine_version FROM pack_versions WHERE pack_id = ?", [row.id]);
    return { packId: String(row.id), scopeKind: String(row.kind), versions };
  }

  async function query(surface: "web" | "mcp", text: string | undefined, f: Filters): Promise<Results> {
    const common = {
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.part !== undefined ? { part: f.part } : {}),
      ...(f.sort !== undefined ? { sort: f.sort } : {}),
      ...(f.limit !== undefined ? { limit: f.limit } : {}),
      ...(f.offset !== undefined ? { offset: f.offset } : {}),
    };
    const res =
      surface === "web"
        ? await driver.http.request({
            surface,
            method: "GET",
            path: `/api/search?${new URLSearchParams({
              ...(text !== undefined ? { q: text } : {}),
              ...Object.fromEntries(Object.entries(common).map(([k, v]) => [k, String(v)])),
              ...(f.verifiedPublisher ? { verified: "1" } : {}),
              ...(f.verifiedDomains ? { verified_domains: f.verifiedDomains.join(",") } : {}),
              ...(f.hasRepository ? { has_repository: "1" } : {}),
              ...(f.engine ? { engine_version: f.engine } : {}),
            })}`,
          })
        : await driver.http.request({
            surface,
            method: "POST",
            path: "/internal/search",
            headers: { "content-type": "application/json" },
            body: {
              ...(text !== undefined ? { query: text } : {}),
              ...common,
              ...(f.verifiedPublisher ? { verified_only: true } : {}),
              ...(f.verifiedDomains ? { verified_domains: f.verifiedDomains } : {}),
              ...(f.hasRepository ? { has_repository: true } : {}),
              ...(f.engine ? { engine_version: f.engine } : {}),
            },
          });
    if (res.status !== 200) throw new InfrastructureError(`search answered ${res.status}: ${res.text}`);
    const body = JSON.parse(aliases.unalias(res.text)) as { cards: ResultCard[]; degraded: boolean };
    return {
      ids: body.cards.map((c) => c.id),
      cards: body.cards,
      degraded: body.degraded,
      slots: body.cards.flatMap((c, i) => (c.exploration ? [i + 1] : [])),
    };
  }

  return {
    search: {
      async list(pack, seed) {
        const { packId, scopeKind, versions } = await identify(pack);
        const eligible = versions.filter((v) => v.state === "active" || v.state === "deprecated").sort((a, b) => compareVersions(String(b.version), String(a.version)));
        const newest = eligible[0];
        if (!newest) throw new InfrastructureError(`${pack.name} has no eligible version to list`);
        const parts = seed.parts ?? ["rules"];
        const score = seed.score ?? 70;
        const listing: Listing = {
          packId,
          name: pack.systemName,
          scopeKind,
          pitch: seed.pitch,
          category: seed.category ?? "other",
          tags: seed.tags ?? [],
          skills: seed.skills ?? [],
          stored: {
            inventory_counts: Object.fromEntries(SEARCH_PARTS.map((p) => [p, parts.includes(p) ? 1 : 0])),
            context_cost: 100,
            verdict: "pass",
            repository: seed.repository ?? null,
            score_parts: [],
          },
          hasRepository: seed.repository !== undefined,
          promotedAt: ago(seed.promoted ?? "30d"),
          newest: { version: String(newest.version), publishedAt: String(newest.published_at), minEngineVersion: (newest.min_engine_version as string | null) ?? null },
          verification: { verified: Number(newest.verified) === 1, domain: (newest.verified_domain as string | null) ?? null, githubOrg: (newest.verified_github_org as string | null) ?? null },
          score,
          stars: 0,
          rating: null,
        };
        let plan;
        try {
          plan = indexPlan(listing, new Date().toISOString());
        } catch (error) {
          if (error instanceof ListingRefused) return new Refusal("category");
          throw error;
        }
        await run([{ sql: "UPDATE pack_versions SET score = ? WHERE pack_id = ?", params: [score, packId] }]);
        if (!plan) return;
        const { ai, vectorize } = fakes();
        for (const near of seed.nearTo ?? []) {
          const vector = conceptVector(near, WIDTH);
          await ai.call("remember", { text: normalizeQuery(near), vector });
          await ai.call("remember", { text: embeddingText(listing), vector });
        }
        await run(plan.statements);
        const [vector] = await ai.call<number[][]>("embed", { texts: [plan.vector.text] });
        await vectorize.call("upsert", { items: [{ id: plan.vector.id, vector, metadata: plan.vector.metadata }] });
      },

      async fill(packs) {
        const { ai, vectorize } = fakes();
        const now = new Date().toISOString();
        const statements: Array<{ sql: string; params?: unknown[] }> = [];
        const vectors: Array<{ id: string; text: string; metadata: object }> = [];
        for (const seed of packs) {
          const [scopeName, packName] = seed.name.slice(1).split("/") as [string, string];
          const scope = aliases.alias(scopeName);
          const packId = crypto.randomUUID();
          const parts = seed.parts ?? ["rules"];
          const listing: Listing = {
            packId,
            name: `@${scope}/${packName}`,
            scopeKind: "org",
            pitch: seed.pitch,
            category: seed.category ?? "other",
            tags: seed.tags ?? [],
            skills: seed.skills ?? [],
            stored: {
              inventory_counts: Object.fromEntries(SEARCH_PARTS.map((p) => [p, parts.includes(p) ? 1 : 0])),
              context_cost: 100,
              verdict: "pass",
              repository: seed.repository ?? null,
              score_parts: [],
            },
            hasRepository: seed.repository !== undefined,
            promotedAt: ago(seed.promoted ?? "30d"),
            newest: { version: "1.0.0", publishedAt: now, minEngineVersion: null },
            verification: { verified: false, domain: null, githubOrg: null },
            score: seed.score ?? 70,
            stars: 0,
            rating: null,
          };
          const plan = indexPlan(listing, now);
          if (!plan) continue;
          statements.push(
            { sql: "INSERT OR IGNORE INTO scopes (id, name, kind, state, created_at) VALUES (?, ?, 'org', 'active', ?)", params: [crypto.randomUUID(), scope, now] },
            { sql: "INSERT INTO packs (id, scope_id, name, visibility, created_at) VALUES (?, (SELECT id FROM scopes WHERE name = ?), ?, 'public', ?)", params: [packId, scope, packName, now] },
            {
              sql: "INSERT INTO pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, score) VALUES (?, ?, '1.0.0', 'active', ?, 1, ?, 0, 0, ?)",
              params: [crypto.randomUUID(), packId, packId, now, listing.score],
            },
            ...plan.statements,
          );
          vectors.push(plan.vector);
        }
        for (let i = 0; i < statements.length; i += 90) await run(statements.slice(i, i + 90));
        const embedded = await ai.call<number[][]>("embed", { texts: vectors.map((v) => v.text) });
        await vectorize.call("upsert", { items: vectors.map((v, i) => ({ id: v.id, vector: embedded[i], metadata: v.metadata })) });
        return packs.map((p) => p.name);
      },

      async signals(pack, seed) {
        const { packId } = await identify(pack);
        await run([
          {
            sql: "INSERT OR REPLACE INTO pack_stats (pack_id, fetches_30d, fetches_7d, fetches_prev_28d, stars, stars_7d, stars_prev_28d, rating, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: [packId, seed.fetches ?? 0, seed.fetchesLast7d ?? 0, seed.fetchesBefore ?? 0, seed.stars ?? 0, seed.starsLast7d ?? 0, seed.starsBefore ?? 0, seed.rating ?? null, new Date().toISOString()],
          },
        ]);
      },

      async demote(pack, reason) {
        const { packId } = await identify(pack);
        await run([{ sql: "UPDATE pack_search SET demotion = ? WHERE pack_id = ?", params: [reason, packId] }]);
      },

      async unlist(pack, how, o) {
        const { packId } = await identify(pack);
        if (how === "private") await run([{ sql: "UPDATE packs SET visibility = 'private' WHERE id = ?", params: [packId] }]);
        else await pack.seedRemoved();
        const plan = removalPlan(packId);
        await run(plan.statements);
        if (!o?.vectorLeft) await fakes().vectorize.call("remove", { ids: [plan.vectorId] });
      },

      async synthetic(pack) {
        const [scope] = pack.systemName.slice(1).split("/") as [string];
        // The scope-kind check belongs to the scopes area; it is lifted for this one statement.
        await run([
          { sql: "PRAGMA ignore_check_constraints = ON" },
          { sql: "UPDATE scopes SET kind = 'synthetic' WHERE name = ?", params: [scope] },
          { sql: "PRAGMA ignore_check_constraints = OFF" },
        ]);
      },

      site: (text, filters = {}) => query("web", text, filters),
      service: (text, filters = {}) => query("mcp", text, filters),

      async categories() {
        const res = await driver.http.request({ surface: "web", method: "GET", path: "/api/categories" });
        if (res.status !== 200) throw new InfrastructureError(`categories answered ${res.status}: ${res.text}`);
        return (JSON.parse(res.text) as { categories: Array<{ category: string; count: number }> }).categories;
      },

      async trending() {
        const res = await driver.http.request({ surface: "web", method: "GET", path: "/api/trending" });
        if (res.status !== 200) throw new InfrastructureError(`trending answered ${res.status}: ${res.text}`);
        return (JSON.parse(aliases.unalias(res.text)) as { cards: Array<{ id: string }> }).cards.map((c) => c.id);
      },

      async vectors() {
        const rowsOf = await rows("SELECT p.id AS id, s.name AS scope, p.name AS name FROM packs p JOIN scopes s ON s.id = p.scope_id");
        const names = new Map(rowsOf.map((r) => [String(r.id), `@${String(r.scope)}/${String(r.name)}`]));
        const ids = await fakes().vectorize.call<string[]>("ids");
        return ids.map((id) => aliases.unalias(names.get(id) ?? id));
      },

      async budget(spent) {
        await fakes().ai.call("spend", { spent });
      },

      async embedded() {
        return (await fakes().ai.call<number[]>("calls")).reduce((n, c) => n + c, 0);
      },
    },
  };
}
