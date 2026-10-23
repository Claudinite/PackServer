import {
  Attestation,
  Meta,
  VERSION_STATUSES,
  type Provenance,
  type VerificationFacts,
  type VersionStatus,
} from "@packserver/schema";
import { compareVersions, latestEligible } from "../index/builders";

/** The four write-once objects beside each public version, and the pack's signed history. */
export const OBJECT_KINDS = ["archive", "sha256", "attestation", "meta", "versions"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

const OBJECT_FILES: Record<Exclude<ObjectKind, "versions">, string> = {
  archive: "pack.tar.zst",
  sha256: "pack.tar.zst.sha256",
  attestation: ".attestation.json",
  meta: "meta.json",
};

/** `@scope/name/<version>/<file>` in `packs-public`; the history is `@scope/name/versions.json`. */
export function objectKey(pack: string, kind: ObjectKind, version?: string): string {
  if (kind === "versions") return `${pack}/versions.json`;
  if (version === undefined) throw new Error(`${kind} is a per-version object`);
  return `${pack}/${version}/${OBJECT_FILES[kind]}`;
}

export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export const CACHE_PRIVATE = "private, no-store";
/** Anonymous reads of a view that a status change can alter: short, and never `immutable`. */
export const CACHE_PUBLIC_VIEW = "public, max-age=60, stale-while-revalidate=300";

interface ObjectHeaders {
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
}

const CONTENT_TYPES: Record<ObjectKind, string> = {
  archive: "application/zstd",
  sha256: "text/plain; charset=utf-8",
  attestation: "application/json",
  meta: "application/json",
  versions: "application/json",
};

/**
 * What a write of a public object must carry as R2 `httpMetadata`: an attachment of a
 * non-HTML type. The versioned objects are written once, so they are `immutable`; the history
 * file is rewritten on every status change, so it is not. `X-Content-Type-Options: nosniff`
 * cannot ride on object metadata: the custom domain's response transform adds it (see
 * `NOSNIFF_HEADER`), and a Worker streaming an object sets it itself with `objectResponseHeaders`.
 */
export function publicObjectHttpMetadata(kind: ObjectKind): ObjectHeaders {
  const file = kind === "versions" ? "versions.json" : OBJECT_FILES[kind];
  return {
    contentType: CONTENT_TYPES[kind],
    contentDisposition: `attachment; filename="${file}"`,
    cacheControl: kind === "versions" ? "public, max-age=60, stale-while-revalidate=300" : CACHE_IMMUTABLE,
  };
}

export const NOSNIFF_HEADER = { name: "x-content-type-options", value: "nosniff" } as const;

/** The response headers a Worker puts on a registry object it streams. */
export function objectResponseHeaders(kind: ObjectKind, options: { private: boolean }): Record<string, string> {
  const meta = publicObjectHttpMetadata(kind);
  return {
    "content-type": meta.contentType,
    "content-disposition": meta.contentDisposition,
    "cache-control": options.private ? CACHE_PRIVATE : meta.cacheControl,
    [NOSNIFF_HEADER.name]: NOSNIFF_HEADER.value,
  };
}

/** Where the custom domain for `packs-public` answers, by environment. */
export function cdnOrigin(environment: string): string {
  if (environment === "production") return "https://packs.claudinite.com";
  if (environment === "staging") return "https://packs-staging.claudinite.com";
  return "https://packs-test.claudinite.com";
}

/** A request that carries a session or a token never gets a shareable response. */
export function viewCacheControl(request: { cookie: string | null; authorization: string | null }): string {
  return request.cookie !== null || request.authorization !== null ? CACHE_PRIVATE : CACHE_PUBLIC_VIEW;
}

export interface PackRow {
  scope: string;
  name: string;
  visibility: string;
}

/** One `pack_versions` row as D1 returns it. */
export interface VersionRow {
  version: string;
  state: string;
  sha256: string;
  upload_sha256: string | null;
  size_bytes: number;
  published_at: string | null;
  verified: boolean;
  verified_domain: string | null;
  verified_github_org: string | null;
  source_verified: boolean;
  min_engine_version: string | null;
  requires: string[];
  source_commit: string | null;
  score: number | null;
  report_key: string | null;
}

/** The reason and security note the signed history carries for a version that is not `active`. */
export interface StatusNote {
  reason?: string | undefined;
  security?: string | undefined;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const flag = (v: unknown): boolean => v === 1 || v === true;

export function parseVersionRow(raw: Record<string, unknown>): VersionRow {
  const requires = typeof raw.requires === "string" ? (JSON.parse(raw.requires) as unknown) : [];
  return {
    version: String(raw.version),
    state: String(raw.state),
    sha256: String(raw.sha256),
    upload_sha256: text(raw.upload_sha256),
    size_bytes: Number(raw.size_bytes),
    published_at: text(raw.published_at),
    verified: flag(raw.verified),
    verified_domain: text(raw.verified_domain),
    verified_github_org: text(raw.verified_github_org),
    source_verified: flag(raw.source_verified),
    min_engine_version: text(raw.min_engine_version),
    requires: Array.isArray(requires) ? requires.map(String) : [],
    source_commit: text(raw.source_commit),
    score: raw.score === null || raw.score === undefined ? null : Number(raw.score),
    report_key: text(raw.report_key),
  };
}

const PUBLISHED: readonly string[] = VERSION_STATUSES;
/** Versions that left validation: `pending` and `approved` rows are invisible to every public reader. */
export const isPublishedState = (state: string): state is VersionStatus => PUBLISHED.includes(state);

/** Statuses whose bytes a resolver may hand out: the archive URL is withheld from the rest. */
const SERVES_BYTES: readonly VersionStatus[] = ["active", "deprecated", "yanked"];
/** Statuses that need a reason from the signed history to be shown honestly. */
export const needsNote = (status: VersionStatus): boolean => status !== "active" && status !== "removed";

export interface VersionSummary {
  version: string;
  status: VersionStatus;
  reason?: string;
  security?: string;
  published_at: string | null;
  /** Absent for a removed version: no hash is published for it. */
  sha256?: string;
  size?: number;
  yanked?: true;
  under_review?: true;
}

export function summarise(row: VersionRow, note: StatusNote = {}): VersionSummary {
  const status = row.state as VersionStatus;
  const out: VersionSummary = { version: row.version, status, published_at: row.published_at };
  if (status !== "removed") {
    out.sha256 = row.sha256;
    out.size = row.size_bytes;
  }
  if (note.reason !== undefined && status !== "active") out.reason = note.reason;
  if (note.security !== undefined && status === "revoked") out.security = note.security;
  if (status === "yanked") out.yanked = true;
  if (status === "quarantined") out.under_review = true;
  return out;
}

export interface PackListing {
  name: string;
  status: "active" | "removed";
  latest_eligible: string | null;
  versions: VersionSummary[];
}

/** A pack is removed once it has published versions and every one of them is. */
export function packIsRemoved(rows: readonly VersionRow[]): boolean {
  const published = rows.filter((r) => isPublishedState(r.state));
  return published.length > 0 && published.every((r) => r.state === "removed");
}

export function buildListing(name: string, rows: readonly VersionRow[], notes: ReadonlyMap<string, StatusNote>): PackListing {
  const published = rows.filter((r) => isPublishedState(r.state)).sort((a, b) => compareVersions(b.version, a.version));
  const removed = packIsRemoved(rows);
  return {
    name,
    status: removed ? "removed" : "active",
    latest_eligible: removed ? null : latestEligible(published.map((r) => ({ version: r.version, status: r.state as VersionStatus }))),
    versions: published.map((r) => summarise(r, notes.get(r.version))),
  };
}

export type VersionLookup =
  | { kind: "found"; row: VersionRow; status: VersionStatus }
  | { kind: "held"; row: VersionRow }
  | { kind: "removed" }
  | { kind: "missing" };

/** What an exact-version read does with each status. */
export function lookupVersion(rows: readonly VersionRow[], version: string): VersionLookup {
  const row = rows.find((r) => r.version === version && isPublishedState(r.state));
  if (!row) return { kind: "missing" };
  const status = row.state as VersionStatus;
  if (status === "removed") return { kind: "removed" };
  if (status === "quarantined") return { kind: "held", row };
  return { kind: "found", row, status };
}

export interface VersionView extends VersionSummary {
  verification: VerificationFacts;
  min_engine_version: string | null;
  requires: string[];
  source_commit: string | null;
  /** Absent for a status no resolver hands bytes out for. */
  urls?: { archive: string; sha256: string; attestation: string; meta: string };
  hashes: { canonical_sha256: string; upload_sha256: string | null };
  inventory: Meta["inventory"];
  capabilities: Meta["capabilities"];
  preinstall: Meta["preinstall"];
  url_inventory: Meta["url_inventory"];
  score: { total: number; parts: Meta["score"]["parts"]; cap: Meta["score"]["cap"] };
  rules_version: string;
  validated_at: string;
  provenance: Provenance;
  diff_summary: Meta["diff_summary"];
  /** Whether a full report is published for this version; its logs are read on the validation page. */
  report_published: boolean;
}

/**
 * The full public view of one version. Verification facts come from the registry row, because a
 * change to the scope's proofs updates them while the write-once `meta.json` keeps the facts of
 * the day it was written.
 */
export function buildVersionView(input: {
  pack: string;
  row: VersionRow;
  note?: StatusNote;
  meta: Meta;
  attestation: Attestation;
  origin: string;
}): VersionView {
  const { pack, row, meta, attestation, origin } = input;
  const summary = summarise(row, input.note);
  const status = summary.status;
  const base = `${origin}/${pack}/${row.version}`;
  const urls = SERVES_BYTES.includes(status)
    ? {
        archive: `${origin}/${objectKey(pack, "archive", row.version)}`,
        sha256: `${origin}/${objectKey(pack, "sha256", row.version)}`,
        attestation: `${origin}/${objectKey(pack, "attestation", row.version)}`,
        meta: `${base}/${OBJECT_FILES.meta}`,
      }
    : undefined;
  return {
    ...summary,
    verification: {
      verified: row.verified,
      verified_domain: row.verified_domain,
      verified_github_org: row.verified_github_org,
      source_verified: row.source_verified,
    },
    min_engine_version: row.min_engine_version,
    requires: row.requires,
    source_commit: row.source_commit,
    ...(urls ? { urls } : {}),
    hashes: { canonical_sha256: row.sha256, upload_sha256: row.upload_sha256 ?? attestation.upload_sha256 },
    inventory: meta.inventory,
    capabilities: meta.capabilities,
    preinstall: meta.preinstall,
    url_inventory: meta.url_inventory,
    score: { total: row.score ?? meta.score.total, parts: meta.score.parts, cap: meta.score.cap },
    rules_version: meta.rules_version,
    validated_at: attestation.validated_at,
    provenance: meta.provenance,
    diff_summary: meta.diff_summary,
    report_published: row.report_key !== null,
  };
}

export interface HashMatch {
  result: "canonical" | "upload";
  pack: string;
  version: string;
  status: VersionStatus;
}
export type HashAnswer = HashMatch | { result: "unknown" };

/**
 * The one answer to a hash lookup. A hash that matches nothing public, a private pack's hash and
 * a removed version's hash all give the same `unknown`.
 */
export function answerHash(
  hash: string,
  candidates: ReadonlyArray<{ pack: string; version: string; state: string; sha256: string; upload_sha256: string | null }>,
): HashAnswer {
  const visible = candidates.filter((c) => isPublishedState(c.state) && c.state !== "removed");
  const canonical = visible.find((c) => c.sha256 === hash);
  const hit = canonical ?? visible.find((c) => c.upload_sha256 === hash);
  if (!hit) return { result: "unknown" };
  return { result: canonical ? "canonical" : "upload", pack: hit.pack, version: hit.version, status: hit.state as VersionStatus };
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
