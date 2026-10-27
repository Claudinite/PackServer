import type { z } from "zod";
import type { SearchSort } from "@packserver/schema";
import { compareVersions } from "../index/builders";
import {
  CATEGORY_MATCH_BOOST,
  DAY_MS,
  ENGINE_INCOMPATIBLE_FACTOR,
  EXPLORATION,
  QUALITY_FLOOR,
  TRENDING,
  type SearchPart,
} from "./constants";
import type { PackCard, StoredCard } from "./listing";

export type Sort = z.infer<typeof SearchSort>;

/** One pack as ranking sees it: the newest eligible version's facts, the pack's stats and how the query matched. */
export interface Candidate {
  packId: string;
  name: string;
  pitch: string;
  category: string;
  parts: SearchPart[];
  hasRepository: boolean;
  stored: StoredCard;
  demoted: boolean;
  version: string;
  publishedAt: string;
  minEngineVersion: string | null;
  verified: boolean;
  verifiedDomain: string | null;
  verifiedGithubOrg: string | null;
  score: number | null;
  stars: number;
  fetches30d: number;
  rating: number | null;
  /** The rating with verified-adoption reviews weighing more; sorting by rating reads this one when a pack has it (REQ-COMM-006). */
  rankedRating?: number | null;
  promotedAt: string | null;
  /** Best-first positive BM25 strength; absent when the text did not match. */
  lexical?: number;
  /** Cosine similarity of the query and the pack's embedding; absent when below the meaning threshold. */
  semantic?: number;
}

export interface Ranked {
  candidate: Candidate;
  relevance: number;
  composite: number;
  exploration?: true;
}

export interface RankContext {
  /** Lowercased words of the query; empty for a browse. */
  terms: string[];
  engineVersion: string | undefined;
  sort: Sort;
  nowMs: number;
  catalogueSize: number;
}

/** Text relevance in (0, 1]: the stronger of the two signals, lifted when both agree. A browse is equally relevant everywhere. */
export function relevanceOf(candidate: Candidate, maxLexical: number, browse: boolean): number {
  if (browse) return 1;
  const lexical = candidate.lexical !== undefined && maxLexical > 0 ? Math.min(1, candidate.lexical / maxLexical) : 0;
  const semantic = candidate.semantic ?? 0;
  return 1 - (1 - lexical) * (1 - semantic);
}

export function compositeOf(candidate: Candidate, relevance: number, ctx: Pick<RankContext, "terms" | "engineVersion">): number {
  const quality = QUALITY_FLOOR + (1 - QUALITY_FLOOR) * ((candidate.score ?? 0) / 100);
  const category = ctx.terms.includes(candidate.category) ? CATEGORY_MATCH_BOOST : 1;
  const needs = candidate.minEngineVersion;
  const incompatible = ctx.engineVersion !== undefined && needs !== null && compareVersions(needs, ctx.engineVersion) > 0;
  return relevance * quality * category * (incompatible ? ENGINE_INCOMPATIBLE_FACTOR : 1);
}

const byName = (a: Ranked, b: Ranked) => (a.candidate.name < b.candidate.name ? -1 : a.candidate.name > b.candidate.name ? 1 : 0);

/** The value an explicit sort orders by; a missing one sorts last. */
function signal(sort: Sort, c: Candidate): number | null {
  switch (sort) {
    case "stars":
      return c.stars;
    case "fetches":
      return c.fetches30d;
    case "rating":
      return c.rankedRating ?? c.rating;
    case "recent":
      return c.promotedAt === null ? null : Date.parse(c.promotedAt);
    case "score":
      return null;
  }
}

/** Demoted packs sit below every other; then the sort; the composite and the name break ties. */
export function order(ranked: Ranked[], sort: Sort): Ranked[] {
  return [...ranked].sort((a, b) => {
    if (a.candidate.demoted !== b.candidate.demoted) return a.candidate.demoted ? 1 : -1;
    if (sort !== "score") {
      const x = signal(sort, a.candidate);
      const y = signal(sort, b.candidate);
      if (x !== y) {
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x;
      }
    }
    return b.composite - a.composite || byName(a, b);
  });
}

export function rankCandidates(candidates: Candidate[], ctx: RankContext): Ranked[] {
  const browse = ctx.terms.length === 0;
  const maxLexical = Math.max(0, ...candidates.map((c) => c.lexical ?? 0));
  const scored = candidates.map((candidate) => {
    const relevance = relevanceOf(candidate, maxLexical, browse);
    return { candidate, relevance, composite: compositeOf(candidate, relevance, ctx) };
  });
  const ordered = order(scored, ctx.sort);
  return ctx.sort === "score" ? withExploration(ordered, ctx.nowMs, ctx.catalogueSize) : ordered;
}

const isFresh = (c: Candidate, nowMs: number): boolean =>
  c.promotedAt !== null && nowMs - Date.parse(c.promotedAt) <= EXPLORATION.windowDays * DAY_MS && (c.score ?? 0) >= EXPLORATION.minScore && !c.demoted;

/**
 * Every tenth position draws the best-scoring fresh pack that the plain order would have left below
 * that position; no verification fact bars one. The rest of the list keeps its plain order.
 */
export function withExploration(ordered: Ranked[], nowMs: number, catalogueSize: number): Ranked[] {
  if (catalogueSize < EXPLORATION.minCatalogue) return ordered;
  const rankOf = new Map(ordered.map((r, i) => [r.candidate.packId, i + 1]));
  const pool = ordered
    .filter((r) => isFresh(r.candidate, nowMs))
    .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0) || byName(a, b));
  const placed = new Set<string>();
  const out: Ranked[] = [];
  let next = 0;
  for (let position = 1; position <= ordered.length; position++) {
    if (position % EXPLORATION.every === 0) {
      const pick = pool.find((r) => !placed.has(r.candidate.packId) && (rankOf.get(r.candidate.packId) as number) > position);
      if (pick) {
        placed.add(pick.candidate.packId);
        out.push({ ...pick, exploration: true });
        continue;
      }
    }
    while (next < ordered.length && placed.has((ordered[next] as Ranked).candidate.packId)) next++;
    const plain = ordered[next++];
    if (plain) {
      placed.add(plain.candidate.packId);
      out.push(plain);
    }
  }
  return out;
}

export function cardOf(r: Ranked): PackCard {
  const c = r.candidate;
  return {
    id: c.name,
    pitch: c.pitch,
    inventory_counts: c.stored.inventory_counts,
    context_cost: c.stored.context_cost,
    verified: c.verified,
    verified_domain: c.verifiedDomain,
    verified_github_org: c.verifiedGithubOrg,
    verdict: c.stored.verdict,
    repository: c.stored.repository,
    rating: c.rating,
    stars: c.stars,
    fetches_30d: c.fetches30d,
    category: c.category,
    score: c.score ?? 0,
    score_parts: c.stored.score_parts,
    newest_eligible: { version: c.version, published_at: c.publishedAt, min_engine_version: c.minEngineVersion },
    ...(r.exploration ? { exploration: true as const } : {}),
  };
}

/**
 * Growth of the last 7 days against the previous 28, per day and smoothed so a pack with no history
 * stays finite; fetches and counted stars weigh equally. Below either floor a pack has no growth at all.
 */
export function trendingGrowth(s: { fetches7d: number; fetchesPrev28d: number; stars7d: number; starsPrev28d: number }): number | null {
  if (s.fetches7d < TRENDING.minFetches7d || s.stars7d < TRENDING.minStars7d) return null;
  const ratio = (recent: number, previous: number) => recent / 7 / ((previous + 1) / 28);
  return Math.sqrt(ratio(s.fetches7d, s.fetchesPrev28d) * ratio(s.stars7d, s.starsPrev28d));
}
