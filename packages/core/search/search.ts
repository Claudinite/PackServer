import type { z } from "zod";
import type { SearchRequest, SearchResponse } from "@packserver/schema";
import { sha256Hex, type Clock, type D1, type Embedder, type KV, type VectorIndex } from "@packserver/ports";
import { compareVersions } from "../index/builders";
import {
  CATEGORIES,
  DEFAULT_LIMIT,
  ELIGIBLE_STATES,
  BM25_WEIGHTS,
  LEXICAL_LIMIT,
  QUERY_EMBEDDING_TTL_S,
  ROW_CAP,
  SEMANTIC_MIN_SCORE,
  SEMANTIC_TOP_K,
  TRENDING,
  isCategory,
  isSearchPart,
  type SearchPart,
} from "./constants";
import { StoredCard, type PackCard, type Snapshot } from "./listing";
import { ftsMatch, normalizeQuery, queryTerms } from "./query";
import { cardOf, rankCandidates, trendingGrowth, type Candidate } from "./rank";

export type SearchRequestBody = z.infer<typeof SearchRequest>;
export type SearchResponseBody = z.infer<typeof SearchResponse>;

export interface SearchPorts {
  d1: D1;
  embedder: Embedder;
  vectors: VectorIndex;
  kv: KV;
  clock: Clock;
}

/** The embedding model is named by configuration, never inferred from the port in hand. */
export interface SearchConfig {
  embeddingModel: string;
  embeddingDimensions: number;
}

export class SearchConfigError extends Error {
  override readonly name = "SearchConfigError";
}
/** A request the caller can fix; `suggestion` names the tool that lists the valid values. */
export class SearchRequestError extends Error {
  override readonly name = "SearchRequestError";
  constructor(
    readonly reason: "unknown_category" | "unknown_part",
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
  }
}

export function assertConfig(config: SearchConfig, embedder: Pick<Embedder, "model" | "dimensions">): void {
  if (!config.embeddingModel || !Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions <= 0) {
    throw new SearchConfigError("the embedding model and its dimension count must be configured");
  }
  if (embedder.model !== config.embeddingModel || embedder.dimensions !== config.embeddingDimensions) {
    throw new SearchConfigError(
      `configured for ${config.embeddingModel} (${config.embeddingDimensions}) but the embedder is ${embedder.model} (${embedder.dimensions})`,
    );
  }
}

const ELIGIBLE = ELIGIBLE_STATES.map((s) => `'${s}'`).join(", ");

/** Public, not synthetic, and holding a version a reader may be sent to. */
const VISIBLE = `p.visibility = 'public' AND s.kind <> 'synthetic' AND EXISTS (SELECT 1 FROM pack_versions v WHERE v.pack_id = p.id AND v.state IN (${ELIGIBLE}) AND v.published_at IS NOT NULL)`;
const BASE = "FROM pack_search ps JOIN packs p ON p.id = ps.pack_id JOIN scopes s ON s.id = p.scope_id";

interface Where {
  sql: string;
  params: unknown[];
}

/** The pack-level filters; verification is a fact of the newest version and is applied once it is known. */
function packFilters(request: SearchRequestBody): Where {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (request.category !== undefined) {
    clauses.push("ps.category = ?");
    params.push(request.category);
  }
  if (request.part !== undefined) {
    clauses.push("instr(' ' || ps.parts || ' ', ?) > 0");
    params.push(` ${request.part} `);
  }
  if (request.has_repository === true) clauses.push("ps.has_repository = 1");
  return { sql: clauses.map((c) => ` AND ${c}`).join(""), params };
}

function validate(request: SearchRequestBody): void {
  if (request.category !== undefined && !isCategory(request.category)) {
    throw new SearchRequestError("unknown_category", `${request.category} is not a category`, "list_categories");
  }
  if (request.part !== undefined && !isSearchPart(request.part)) {
    throw new SearchRequestError("unknown_part", `${request.part} is not a part`, "rules, skills, checks, guards, tasks");
  }
}

async function lexicalHits(d1: D1, request: SearchRequestBody, match: string): Promise<Map<string, number>> {
  const w = packFilters(request);
  const w2 = Object.values(BM25_WEIGHTS).map((n) => n.toFixed(1)).join(", ");
  const result = await d1.query(
    `SELECT ps.pack_id AS pack_id, bm25(packs_fts, ${w2}) AS rank
FROM packs_fts JOIN pack_search ps ON ps.seq = packs_fts.rowid JOIN packs p ON p.id = ps.pack_id JOIN scopes s ON s.id = p.scope_id
WHERE packs_fts MATCH ? AND ${VISIBLE}${w.sql}
ORDER BY rank LIMIT ${LEXICAL_LIMIT}`,
    [match, ...w.params],
  );
  // bm25() is lower for a better match and negative; the strength is its magnitude.
  return new Map(result.rows.map((r) => [String(r.pack_id), Math.max(0, -Number(r.rank))]));
}

const asNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The newest eligible version of each pack, with the pack's search row and stats. */
async function hydrate(d1: D1, request: SearchRequestBody, ids: string[] | undefined): Promise<Candidate[]> {
  const w = packFilters(request);
  const restrict = ids === undefined ? "" : " AND ps.pack_id IN (SELECT value FROM json_each(?))";
  const result = await d1.query(
    `SELECT ps.pack_id, ps.name, ps.pitch, ps.category, ps.parts, ps.has_repository, ps.card, ps.demotion,
  pv.version, pv.published_at, pv.verified, pv.verified_domain, pv.verified_github_org, pv.score, pv.min_engine_version,
  COALESCE(st.stars, 0) AS stars, COALESCE(st.fetches_30d, 0) AS fetches_30d, st.rating AS rating, r.promoted_at AS promoted_at
${BASE}
JOIN pack_versions pv ON pv.pack_id = p.id AND pv.state IN (${ELIGIBLE}) AND pv.published_at IS NOT NULL
LEFT JOIN pack_stats st ON st.pack_id = p.id LEFT JOIN recent r ON r.pack_id = p.id
WHERE p.visibility = 'public' AND s.kind <> 'synthetic'${w.sql}${restrict}
LIMIT ${ROW_CAP}`,
    [...w.params, ...(ids === undefined ? [] : [JSON.stringify(ids)])],
  );
  const newest = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    const id = String(row.pack_id);
    const held = newest.get(id);
    if (!held || compareVersions(String(row.version), String(held.version)) > 0) newest.set(id, row);
  }
  const out: Candidate[] = [];
  for (const row of newest.values()) {
    let stored: StoredCard;
    try {
      stored = StoredCard.parse(JSON.parse(String(row.card)));
    } catch {
      console.warn(`search: unreadable card for ${String(row.name)}`);
      continue;
    }
    out.push({
      packId: String(row.pack_id),
      name: String(row.name),
      pitch: String(row.pitch),
      category: String(row.category),
      parts: String(row.parts).split(" ").filter(isSearchPart),
      hasRepository: Number(row.has_repository) === 1,
      stored,
      demoted: row.demotion !== null && row.demotion !== undefined,
      version: String(row.version),
      publishedAt: String(row.published_at),
      minEngineVersion: asText(row.min_engine_version),
      verified: Number(row.verified) === 1,
      verifiedDomain: asText(row.verified_domain),
      verifiedGithubOrg: asText(row.verified_github_org),
      score: asNumber(row.score),
      stars: Number(row.stars),
      fetches30d: Number(row.fetches_30d),
      rating: asNumber(row.rating),
      promotedAt: asText(row.promoted_at),
    });
  }
  return out;
}

function verificationFilter(request: SearchRequestBody): (c: { verified: boolean; verifiedDomain: string | null }) => boolean {
  const domains = request.verified_domains?.map((d) => d.toLowerCase());
  return (c) =>
    (request.verified_only !== true || c.verified) &&
    (domains === undefined || domains.length === 0 || (c.verified && c.verifiedDomain !== null && domains.includes(c.verifiedDomain.toLowerCase())));
}

async function catalogueSize(d1: D1): Promise<number> {
  const result = await d1.query(`SELECT COUNT(*) AS n ${BASE} WHERE ${VISIBLE}`);
  return Number(result.rows[0]?.n ?? 0);
}

/** A query's embedding, from the 24 h cache when it is there; the model is called, and paid for, only on a miss. */
async function queryVector(ports: SearchPorts, config: SearchConfig, query: string): Promise<number[]> {
  const key = `search:embedding:${config.embeddingModel}:${await sha256Hex(normalizeQuery(query))}`;
  const cached = await ports.kv.get(key);
  if (cached !== null) {
    const parsed = JSON.parse(cached) as number[];
    if (parsed.length === config.embeddingDimensions) return parsed;
  }
  const [vector] = await ports.embedder.embed([normalizeQuery(query)]);
  if (!vector || vector.length !== config.embeddingDimensions) throw new SearchConfigError("the embedder answered a vector of the wrong width");
  await ports.kv.put(key, JSON.stringify(vector), { ttl_seconds: QUERY_EMBEDDING_TTL_S });
  return vector;
}

/** Packs nearest the query by meaning; null when the model cannot be used (budget spent, outage). */
async function semanticHits(ports: SearchPorts, config: SearchConfig, query: string) {
  try {
    const vector = await queryVector(ports, config, query);
    const matches = await ports.vectors.query(vector, { topK: SEMANTIC_TOP_K });
    return matches.filter((m) => m.score >= SEMANTIC_MIN_SCORE);
  } catch (error) {
    console.warn(`search: meaning search unavailable, answering by keyword (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

const clampLimit = (n: number | undefined): number => n ?? DEFAULT_LIMIT;

/** Search and browse: the one implementation both the site and MCP answer from. */
export async function search(ports: SearchPorts, config: SearchConfig, request: SearchRequestBody): Promise<SearchResponseBody> {
  assertConfig(config, ports.embedder);
  validate(request);
  const query = request.query?.trim();
  const terms = query ? queryTerms(query) : [];
  const browse = query === undefined || query === "";
  const passes = verificationFilter(request);
  const semanticPromise = browse ? Promise.resolve([]) : semanticHits(ports, config, query);

  let candidates: Candidate[];
  let degraded: boolean;
  try {
    const match = browse ? null : ftsMatch(query);
    const lexical = match === null ? new Map<string, number>() : await lexicalHits(ports.d1, request, match);
    const semantic = await semanticPromise;
    degraded = semantic === null;
    const meaning = new Map((semantic ?? []).map((m) => [m.id, m.score]));
    const ids = browse ? undefined : [...new Set([...lexical.keys(), ...meaning.keys()])];
    candidates = ids !== undefined && ids.length === 0 ? [] : await hydrate(ports.d1, request, ids);
    for (const c of candidates) {
      const strength = lexical.get(c.packId);
      const similarity = meaning.get(c.packId);
      if (strength !== undefined) c.lexical = strength;
      if (similarity !== undefined) c.semantic = similarity;
    }
  } catch (error) {
    const fallback = await fromSnapshots(await semanticPromise, request);
    if (fallback === null) throw error;
    console.warn(`search: the database is unavailable, answering from the vector index (${error instanceof Error ? error.message : String(error)})`);
    return { cards: fallback.slice(request.offset ?? 0, (request.offset ?? 0) + clampLimit(request.limit)), degraded: true };
  }

  const sort = request.sort ?? "score";
  const kept = candidates.filter(passes);
  const size = sort === "score" && kept.length >= 10 ? await catalogueSize(ports.d1) : 0;
  const ranked = rankCandidates(kept, { terms, engineVersion: request.engine_version, sort, nowMs: ports.clock.now(), catalogueSize: size });
  const offset = request.offset ?? 0;
  return { cards: ranked.slice(offset, offset + clampLimit(request.limit)).map(cardOf), degraded };
}

/** With D1 down, the vector index's own snapshots answer, best meaning first. */
async function fromSnapshots(matches: Awaited<ReturnType<typeof semanticHits>>, request: SearchRequestBody): Promise<PackCard[] | null> {
  if (matches === null || matches.length === 0) return null;
  const passes = verificationFilter(request);
  const cards: PackCard[] = [];
  for (const m of matches) {
    const text = m.metadata.snapshot;
    if (typeof text !== "string") continue;
    const snapshot = JSON.parse(text) as Snapshot;
    const { card } = snapshot;
    const holds = (part: SearchPart) => snapshot.parts.includes(part);
    if (request.category !== undefined && card.category !== request.category) continue;
    if (request.part !== undefined && !holds(request.part as SearchPart)) continue;
    if (request.has_repository === true && !snapshot.has_repository) continue;
    if (!passes({ verified: card.verified, verifiedDomain: card.verified_domain })) continue;
    cards.push(card);
  }
  return cards;
}

/** The fixed category list with the number of public packs in each. */
export async function listCategories(d1: D1): Promise<Array<{ category: string; count: number }>> {
  const result = await d1.query(
    `SELECT ps.category AS category, COUNT(*) AS n ${BASE} WHERE ${VISIBLE} GROUP BY ps.category`,
  );
  const counts = new Map(result.rows.map((r) => [String(r.category), Number(r.n)]));
  return CATEGORIES.map((category) => ({ category, count: counts.get(category) ?? 0 }));
}

/** Packs growing fastest over the last 7 days against the previous 28; a pack under either floor is absent. */
export async function trending(d1: D1, limit: number = TRENDING.limit): Promise<PackCard[]> {
  const result = await d1.query(
    `SELECT ps.pack_id AS pack_id, st.fetches_7d AS f7, st.fetches_prev_28d AS fp, st.stars_7d AS s7, st.stars_prev_28d AS sp
${BASE} JOIN pack_stats st ON st.pack_id = p.id
WHERE ${VISIBLE} AND ps.demotion IS NULL AND st.fetches_7d >= ? AND st.stars_7d >= ?`,
    [TRENDING.minFetches7d, TRENDING.minStars7d],
  );
  const growth = new Map<string, number>();
  for (const r of result.rows) {
    const g = trendingGrowth({ fetches7d: Number(r.f7), fetchesPrev28d: Number(r.fp), stars7d: Number(r.s7), starsPrev28d: Number(r.sp) });
    if (g !== null) growth.set(String(r.pack_id), g);
  }
  if (growth.size === 0) return [];
  const candidates = await hydrate(d1, {}, [...growth.keys()]);
  return candidates
    .sort((a, b) => (growth.get(b.packId) as number) - (growth.get(a.packId) as number) || (a.name < b.name ? -1 : 1))
    .slice(0, limit)
    .map((c) => cardOf({ candidate: c, relevance: 1, composite: 1 }));
}
