import { z } from "zod";
import { PackCard, ScoreBreakdown, Verdict } from "@packserver/schema";
import type { Embedder, VectorIndex } from "@packserver/ports";
import type { D1 } from "@packserver/ports";
import { CATEGORIES, SEARCH_PARTS, isCategory, type SearchPart } from "./constants";

export type PackCard = z.infer<typeof PackCard>;

/** The card fields only `meta.json` knows; the rest of a card is read live from the version row. */
export const StoredCard = z.object({
  inventory_counts: z.record(z.string(), z.number().int().nonnegative()),
  context_cost: z.number().int().nonnegative(),
  verdict: Verdict,
  repository: z.string().nullable(),
  score_parts: ScoreBreakdown.shape.parts,
});
export type StoredCard = z.infer<typeof StoredCard>;

export interface Listing {
  packId: string;
  /** `@scope/name`. */
  name: string;
  /** A synthetic scope is never searchable (REQ-OPS-001). */
  scopeKind: string;
  pitch: string;
  category: string;
  tags: string[];
  skills: Array<{ name: string; description: string }>;
  stored: StoredCard;
  hasRepository: boolean;
  /** When the pack's first version was promoted. */
  promotedAt: string;
  newest: { version: string; publishedAt: string; minEngineVersion: string | null };
  verification: { verified: boolean; domain: string | null; githubOrg: string | null };
  score: number;
  stars: number;
  rating: number | null;
}

export class ListingRefused extends Error {
  override readonly name = "ListingRefused";
  constructor(
    readonly reason: "category",
    message: string,
  ) {
    super(message);
  }
}

export interface Statement {
  sql: string;
  params: unknown[];
}

export interface VectorEntry {
  id: string;
  text: string;
  metadata: { pack: string; category: string };
}

export interface IndexPlan {
  statements: Statement[];
  vector: VectorEntry;
}

/** The text the embedder sees: what a task-phrased query is meant to land near. */
export function embeddingText(listing: Pick<Listing, "pitch" | "category" | "tags" | "skills">): string {
  return [listing.pitch, listing.category, listing.tags.join(" "), ...listing.skills.map((s) => s.description)].join("\n").slice(0, 6000);
}

export const partsOf = (counts: Record<string, number>): SearchPart[] => SEARCH_PARTS.filter((p) => (counts[p] ?? 0) > 0);

/**
 * Everything a promotion writes for search: the searchable row, the first-promotion time and the
 * vector's text and metadata. A synthetic scope's pack has no plan at all.
 * Throws `ListingRefused` for a category outside the fixed list.
 */
export function indexPlan(listing: Listing, nowIso: string): IndexPlan | null {
  if (listing.scopeKind === "synthetic") return null;
  if (!isCategory(listing.category)) {
    throw new ListingRefused("category", `${listing.category} is not one of: ${CATEGORIES.join(", ")}`);
  }
  const parts = partsOf(listing.stored.inventory_counts);
  const skills = listing.skills.map((s) => `${s.name}\n${s.description}`).join("\n");
  const statements: Statement[] = [
    {
      sql: `INSERT INTO pack_search (pack_id, name, pitch, category, tags, skills, parts, has_repository, card, demotion, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
ON CONFLICT(pack_id) DO UPDATE SET name = excluded.name, pitch = excluded.pitch, category = excluded.category, tags = excluded.tags,
  skills = excluded.skills, parts = excluded.parts, has_repository = excluded.has_repository, card = excluded.card, updated_at = excluded.updated_at`,
      params: [listing.packId, listing.name, listing.pitch, listing.category, listing.tags.join(" "), skills, parts.join(" "), listing.hasRepository ? 1 : 0, JSON.stringify(listing.stored), nowIso],
    },
    { sql: "INSERT INTO recent (pack_id, promoted_at) VALUES (?, ?) ON CONFLICT(pack_id) DO NOTHING", params: [listing.packId, listing.promotedAt] },
  ];
  return {
    statements,
    vector: {
      id: listing.packId,
      text: embeddingText(listing),
      metadata: { pack: listing.name, category: listing.category },
    },
  };
}

/** A pack made private or removed leaves search: its row, its first-promotion time and (by the caller) its vector. */
export function removalPlan(packId: string): { statements: Statement[]; vectorId: string } {
  return {
    statements: [
      { sql: "DELETE FROM pack_search WHERE pack_id = ?", params: [packId] },
      { sql: "DELETE FROM recent WHERE pack_id = ?", params: [packId] },
    ],
    vectorId: packId,
  };
}

export interface IndexPorts {
  d1: Pick<D1, "batch">;
  embedder: Pick<Embedder, "embed" | "dimensions">;
  vectors: Pick<VectorIndex, "upsert" | "deleteByIds">;
}

/** Promotion's call: the row first, so the pack is findable by keyword even if the embedder is out. */
export async function applyIndex(ports: IndexPorts, listing: Listing, nowIso: string): Promise<{ vectorised: boolean } | null> {
  const plan = indexPlan(listing, nowIso);
  if (!plan) return null;
  await ports.d1.batch(plan.statements);
  const [vector] = await ports.embedder.embed([plan.vector.text]);
  if (!vector || vector.length !== ports.embedder.dimensions) return { vectorised: false };
  await ports.vectors.upsert([{ id: plan.vector.id, vector, metadata: plan.vector.metadata }]);
  return { vectorised: true };
}

/**
 * The vector goes first and a failure to delete it fails the call, so the caller retries before the pack is
 * made private or synthetic: a vector must never outlive the pack's right to be found.
 */
export async function applyRemoval(ports: { d1: IndexPorts["d1"]; vectors: Pick<IndexPorts["vectors"], "deleteByIds"> }, packId: string): Promise<void> {
  const plan = removalPlan(packId);
  await ports.vectors.deleteByIds([plan.vectorId]);
  await ports.d1.batch(plan.statements);
}
