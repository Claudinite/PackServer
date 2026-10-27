import { adoptionOf } from "@packserver/core/github";
import { objectKey, type PackListing, type VersionView } from "@packserver/core/catalog";
import { reportedUnderReview } from "@packserver/core/moderation";
import { advisoriesFor, type Advisory } from "@packserver/core/reports";
import { loadProfile, type Profile } from "@packserver/core/scopes";
import { StoredCard } from "@packserver/core/search";
import { Attestation, PackName, PackVersion, VersionsDocument } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { runtimeOf, type WebEnv } from "../../context";
import { routes as viewRoutes } from "../../routes/packs/view";

export interface Signals {
  stars: number | null;
  rating: number | null;
  /** How many visible reviews the rating is made of; null while the pack has no rating. */
  ratingCount: number | null;
  fetches30d: number | null;
  fetches7d: number | null;
  fetchesPrev28d: number | null;
}

/** Warning counts by category from `meta.json`, or why they cannot be said: unknown is never a count of zero. */
export type ReportFacts = { kind: "unavailable" } | { kind: "found"; runId: string | null; warnings: Record<string, number> };

export interface VersionExtras {
  score: number | null;
}

export interface PackData {
  name: string;
  scope: string;
  visibility: "public" | "private";
  /** The version the URL asked for, when it named one. */
  requested: string | undefined;
  listing: PackListing;
  /** The version the page describes; null when none can be shown, as when every version is held. */
  version: VersionView | null;
  pitch: string;
  category: string;
  repository: string | null;
  signals: Signals;
  profile: Profile;
  advisories: Advisory[];
  /** Whether a high-severity abuse report is waiting for a person; null for a private pack, which has no such label. */
  reported: boolean | null;
  /** The engine release `cn_min_adopt_version` names; null while the flag is unset. */
  adoptVersion: string | null;
  kid: string | null;
  report: ReportFacts;
  /** Domains linked from the version's prose that a weekly rescan found resolving differently from when they were first seen. */
  changedDomains: string[];
  versionExtras: Map<string, VersionExtras>;
  /** Repositories declaring the pack in the latest completed weekly scan; null until one has covered it. */
  declaringRepositories: number | null;
}

export type PackLoad =
  | { kind: "ok"; data: PackData }
  | { kind: "not_found" }
  | { kind: "removed" }
  | { kind: "unavailable" };

type ViewBody = PackListing & { version: VersionView | null };

/** Asks the pack read API in-process, so the page and `/api/packs` answer from one implementation. */
async function askView(c: Context<WebEnv>, path: string): Promise<Response> {
  const runtime = runtimeOf(c);
  const inner = new Hono<WebEnv>();
  inner.use(async (c2, next) => {
    c2.set("runtime", runtime);
    await next();
  });
  inner.route("/", viewRoutes);
  return inner.request(path);
}

const count = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function parseCard(raw: string): StoredCard | undefined {
  try {
    return StoredCard.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function adoptFlag(c: Context<WebEnv>): Promise<string | null> {
  const { rows } = await runtimeOf(c).ports.d1.query("SELECT value FROM feature_flags WHERE key = 'cn_min_adopt_version'");
  const raw = rows[0]?.value;
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

async function readPublic(c: Context<WebEnv>, key: string): Promise<unknown | undefined> {
  const body = await runtimeOf(c).ports.r2.PACKS_PUBLIC?.get(key);
  if (!body) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

const MetaWarnings = z.object({
  warnings: z.record(z.string(), z.number().int().nonnegative()),
  validation_run: z.string().min(1).optional(),
});

/** The validator counts warnings by category into the version's `meta.json`. */
async function readWarnings(c: Context<WebEnv>, name: string, version: string | undefined): Promise<ReportFacts> {
  if (version === undefined) return { kind: "unavailable" };
  const parsed = MetaWarnings.safeParse(await readPublic(c, objectKey(name, "meta", version)));
  if (!parsed.success) return { kind: "unavailable" };
  return { kind: "found", runId: parsed.data.validation_run ?? null, warnings: parsed.data.warnings };
}

/** Everything the pack page and its tabs show, or the reason there is nothing to show. */
export async function loadPack(c: Context<WebEnv>, scope: string, packName: string, requested?: string): Promise<PackLoad> {
  const name = `${scope}/${packName}`;
  if (!PackName.safeParse(name).success) return { kind: "not_found" };
  if (requested !== undefined && !PackVersion.safeParse(requested).success) return { kind: "not_found" };
  try {
    return await load(c, name, scope, packName, requested);
  } catch {
    return { kind: "unavailable" };
  }
}

async function load(c: Context<WebEnv>, name: string, scope: string, packName: string, requested: string | undefined): Promise<PackLoad> {
  const base = `/packs/${name}`;
  let answer = await askView(c, requested === undefined ? base : `${base}/${requested}`);
  let held = false;
  if (answer.status === 451) {
    held = true;
    answer = await askView(c, base);
  }
  if (answer.status === 404) return { kind: "not_found" };
  if (answer.status === 410) {
    // A removed exact version is a missing page; a removed pack is gone.
    return requested === undefined ? { kind: "removed" } : { kind: "not_found" };
  }
  if (answer.status !== 200) return { kind: "unavailable" };
  const view = (await answer.json()) as ViewBody;

  const { d1 } = runtimeOf(c).ports;
  const found = await d1.query(
    "SELECT p.id AS id, p.visibility AS visibility FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?",
    [scope.slice(1), packName],
  );
  const pack = found.rows[0];
  if (!pack) return { kind: "not_found" };
  const packId = String(pack.id);
  const version = held ? null : view.version;

  const [listed, versions, profile, advisories, adoptVersion, attestation, adoption, reported] = await Promise.all([
    d1.query(
      `SELECT ps.pitch AS pitch, ps.category AS category, ps.card AS card, st.stars AS stars, st.rating AS rating, pr.review_count AS rating_count, st.fetches_30d AS fetches_30d,
        st.fetches_7d AS fetches_7d, st.fetches_prev_28d AS fetches_prev_28d
FROM pack_search ps LEFT JOIN pack_stats st ON st.pack_id = ps.pack_id LEFT JOIN pack_ratings pr ON pr.pack_id = ps.pack_id WHERE ps.pack_id = ?`,
      [packId],
    ),
    d1.query("SELECT version, score FROM pack_versions WHERE pack_id = ?", [packId]),
    loadProfile(d1, scope.slice(1)),
    advisoriesFor(d1, packId),
    adoptFlag(c),
    version ? readPublic(c, objectKey(name, "attestation", version.version)) : Promise.resolve(undefined),
    adoptionOf(d1, name),
    reportedUnderReview(d1, packId),
  ]);

  const row = listed.rows[0];
  if (!row || !profile || typeof row.pitch !== "string") return { kind: "unavailable" };
  const card = typeof row.card === "string" ? parseCard(row.card) : undefined;
  if (!card) return { kind: "unavailable" };

  const versionExtras = new Map<string, VersionExtras>(
    versions.rows.map((r) => [String(r.version), { score: count(r.score) }]),
  );
  const parsedAttestation = Attestation.safeParse(attestation);
  const shownReport = await readWarnings(c, name, version?.version);
  const changed = version
    ? await d1.query(
        `SELECT w.subject AS subject FROM version_warnings w JOIN pack_versions v ON v.id = w.version_id WHERE v.pack_id = ? AND v.version = ? AND w.kind = 'domain-drift' ORDER BY w.subject`,
        [packId, version.version],
      )
    : { rows: [] };

  return {
    kind: "ok",
    data: {
      name,
      scope,
      visibility: pack.visibility === "private" ? "private" : "public",
      requested,
      listing: view,
      version,
      pitch: row.pitch,
      category: String(row.category),
      repository: card.repository,
      signals: {
        stars: count(row.stars),
        rating: count(row.rating),
        ratingCount: count(row.rating_count),
        fetches30d: count(row.fetches_30d),
        fetches7d: count(row.fetches_7d),
        fetchesPrev28d: count(row.fetches_prev_28d),
      },
      profile,
      advisories,
      reported: pack.visibility === "private" ? null : reported,
      adoptVersion,
      kid: parsedAttestation.success ? parsedAttestation.data.kid : null,
      report: shownReport,
      changedDomains: changed.rows.map((r) => String(r.subject)),
      versionExtras,
      declaringRepositories: adoption.declaringRepositories,
    },
  };
}

/** The signed history, for the versions tab; null when it cannot be read. */
export async function loadHistory(c: Context<WebEnv>, name: string): Promise<VersionsDocument | null> {
  const parsed = VersionsDocument.safeParse(await readPublic(c, objectKey(name, "versions")));
  return parsed.success ? parsed.data : null;
}
