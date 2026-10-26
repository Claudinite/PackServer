import { MAX_UPLOAD_BYTES, stagingPrefix } from "./staging";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** REQ-PUB-026 and REQ-ABUSE-003 (D44): new packs a scope may create in a UTC day. */
export const NEW_PACKS_PER_SCOPE_PER_DAY = 5;
export const NEW_PACKS_PER_VERIFIED_SCOPE_PER_DAY = 20;
/** D44: new packs one account may create in a UTC day, across every scope it publishes to. */
export const NEW_PACKS_PER_ACCOUNT_PER_DAY = 20;
/** REQ-PUB-026 (D14): new versions one pack accepts in a UTC day. */
export const VERSIONS_PER_PACK_PER_DAY = 20;
/** REQ-VAL-021 (D28, D45): validation runs of every kind, and the dry-runs among them, one publisher starts in a UTC day. */
export const RUNS_PER_PUBLISHER_PER_DAY = 60;
export const DRY_RUNS_PER_PUBLISHER_PER_DAY = 20;
/** Until the account is this old or has a promoted pack, the lower dry-run cap applies. */
export const YOUNG_DRY_RUNS_PER_DAY = 3;
export const YOUNG_ACCOUNT_MS = 7 * DAY_MS;
/** REQ-VAL-017 (D46): this many failed runs in a UTC day queue a publisher's further runs. */
export const SOFT_RATE_LIMIT_FAILED_RUNS = 10;
export const SOFT_RATE_LIMIT_INTERVAL_MS = 10 * MINUTE_MS;
/** REQ-OPS-001: scopes whose publishes skip the prose screen and the human queue, and whose versions expire. */
export const SYNTHETIC_SCOPES: readonly string[] = ["probe"];
export const SYNTHETIC_VERSION_TTL_MS = DAY_MS;

export const isSyntheticScope = (scopeName: string): boolean => SYNTHETIC_SCOPES.includes(scopeName);

export type QuotaKind = "new_packs_per_scope" | "new_packs_per_account" | "validation_runs" | "dry_runs" | "versions_per_pack";

/** The UTC day an instant falls in, `YYYY-MM-DD`: the `day` of a `Quota` key. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The first instant of the next UTC day, when every daily count starts again. */
export const nextUtcMidnight = (ms: number): number => Date.parse(`${utcDay(ms)}T00:00:00.000Z`) + DAY_MS;

export const newPackCap = (verifiedPublisher: boolean): number =>
  verifiedPublisher ? NEW_PACKS_PER_VERIFIED_SCOPE_PER_DAY : NEW_PACKS_PER_SCOPE_PER_DAY;

/** An account under 7 days old with no promoted pack: capped lower, and the first to queue when the sandbox budget is spent. */
export const isYoungAccount = (account: { ageMs: number; hasPromotedPack: boolean }): boolean =>
  account.ageMs < YOUNG_ACCOUNT_MS && !account.hasPromotedPack;

export const dryRunCap = (account: { ageMs: number; hasPromotedPack: boolean }): number =>
  isYoungAccount(account) ? YOUNG_DRY_RUNS_PER_DAY : DRY_RUNS_PER_PUBLISHER_PER_DAY;

/**
 * REQ-PUB-026: whether a scope has a Verified Publisher's higher new-pack cap. Until scopes carry
 * the admin's decision, a proven domain or GitHub organisation stands for it.
 */
export const isVerifiedPublisher = (scope: { verified_domain: string | null; verified_github_org: string | null }): boolean =>
  scope.verified_domain !== null || scope.verified_github_org !== null;

/**
 * When a soft-limited publisher's next run may begin: one slot every ten minutes after the latest
 * start already granted, never before now. A publisher under the limit starts at once.
 */
export function nextRunStart(input: { now: number; softLimited: boolean; latestGrantedStart: number | null }): number {
  if (!input.softLimited) return input.now;
  return Math.max(input.now, input.latestGrantedStart ?? input.now) + SOFT_RATE_LIMIT_INTERVAL_MS;
}

export const INTEGRITY_FAILURES = ["integrity.oversize", "integrity.not_zstd", "integrity.sha256_mismatch"] as const;
export type IntegrityFailure = (typeof INTEGRITY_FAILURES)[number];
export type Integrity = { ok: true; sha256: string } | { ok: false; reason: IntegrityFailure };

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** A zstd frame starts with this magic number; a skippable frame (0x184D2A5_) is not an archive the registry accepts. */
export const hasZstdMagic = (bytes: Uint8Array): boolean => ZSTD_MAGIC.every((b, i) => bytes[i] === b);

/**
 * REQ-VAL-002, cheapest check first: the length of the bytes actually stored, then their first
 * four bytes, then their hash. Nothing is decompressed, so a bomb costs one read of at most 3 MiB.
 */
export async function checkIntegrity(
  stored: { size: number; read(): Promise<Uint8Array | null> },
  declaredSha256: string,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<Integrity> {
  if (stored.size > MAX_UPLOAD_BYTES) return { ok: false, reason: "integrity.oversize" };
  const bytes = await stored.read();
  if (bytes === null) throw new Error("the staged object disappeared between its size and its read");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "integrity.oversize" };
  if (!hasZstdMagic(bytes)) return { ok: false, reason: "integrity.not_zstd" };
  const sha256 = await sha256Hex(bytes);
  return sha256 === declaredSha256 ? { ok: true, sha256 } : { ok: false, reason: "integrity.sha256_mismatch" };
}

/** What a refused daily cap tells the publisher: the count and when it starts again. */
export function capMessage(what: string, cap: number, now: number): string {
  return `${what} is capped at ${cap} a day; the count starts again at ${new Date(nextUtcMidnight(now)).toISOString()}`;
}

/** REQ-VAL-043: a dry-run stages under a prefix of its own, so its object is never one a version could be promoted from. */
export function dryRunStagingKey(scope: string, name: string, version: string, credentialId: string): string {
  return `${stagingPrefix(scope)}dry-run/${name}/${version}/${credentialId}.tar.zst`;
}
