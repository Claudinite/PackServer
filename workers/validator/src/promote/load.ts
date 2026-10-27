import { hasPublisherChange } from "@packserver/core/publishing";
import type { D1 } from "@packserver/ports";

/** A validation run as promotion reads it: the verdict, the committed form and who stood behind it. */
export interface PromotionRun {
  id: string;
  kind: "publish" | "dry-run";
  source: "oidc" | "upload";
  synthetic: number;
  scope_id: string;
  scope: string;
  scope_kind: string;
  pack_name: string;
  version: string;
  principal: string;
  credential_id: string;
  declared_sha256: string;
  status: string;
  verdict: string | null;
  widening: number | null;
  source_verified: number | null;
  score: number | null;
  rules_version: string | null;
  canonical_sha256: string | null;
  canonical_key: string | null;
  tree_hash: string | null;
  report_key: string | null;
  finished_at: string | null;
}

export const packOf = (run: Pick<PromotionRun, "scope" | "pack_name">): string => `@${run.scope}/${run.pack_name}`;

export async function loadPromotion(d1: D1, runId: string): Promise<PromotionRun> {
  const row = (
    await d1.query(
      `select r.id, r.kind, r.source, r.synthetic, r.scope_id, s.name as scope, s.kind as scope_kind, r.pack_name, r.version, r.principal, r.credential_id, r.declared_sha256,
              r.status, r.verdict, r.widening, r.source_verified, r.score, r.rules_version, r.canonical_sha256, r.canonical_key, r.tree_hash, r.report_key, r.finished_at
         from validation_runs r join scopes s on s.id = r.scope_id where r.id = ?`,
      [runId],
    )
  ).rows[0];
  if (!row) throw new Error(`no validation run ${runId}`);
  return row as unknown as PromotionRun;
}

/** What people have already decided about a run that validated: an admin cleared its hold, an owner approved it. */
export interface Clearance {
  released?: boolean;
  approved?: boolean;
}

/**
 * Whether a finished run may be promoted: a publish that passed or only warned (or whose hold an admin
 * cleared), and that does not widen what the pack may do unless an owner approved it.
 */
export function promotable(run: PromotionRun, cleared: Clearance = {}): boolean {
  return (
    run.kind === "publish" &&
    run.status === "finished" &&
    (run.verdict === "pass" || run.verdict === "warn" || (run.verdict === "hold" && cleared.released === true)) &&
    (run.widening === 0 || run.widening === null || cleared.approved === true) &&
    run.canonical_key !== null &&
    run.canonical_sha256 !== null &&
    run.report_key !== null
  );
}

export interface VersionRow {
  id: string;
  pack_id: string;
  state: string;
  sha256: string;
  visibility: "public" | "private";
}

export async function versionRow(d1: D1, run: PromotionRun): Promise<VersionRow | null> {
  const row = (
    await d1.query(
      `select v.id, v.pack_id, v.state, v.sha256, p.visibility from pack_versions v join packs p on p.id = v.pack_id
        where p.scope_id = ? and p.name = ? and v.version = ?`,
      [run.scope_id, run.pack_name, run.version],
    )
  ).rows[0];
  return (row as unknown as VersionRow | undefined) ?? null;
}

/** Days without a publish after which the next version is owed the first-publish review (REQ-VAL-038). */
export const DORMANT_DAYS = 180;

/** The feature flag holding how many public repositories must declare a pack before its versions are staged (D43); off until a weekly scan has counted. */
export const DECLARED_THRESHOLD_FLAG = "staged_publishing_declared_threshold";
/** What the flag says until an admin sets it. */
export const DEFAULT_DECLARED_THRESHOLD = 100;

export type StagingReason = "widening" | "publisher-change" | "dormant" | "verified-publisher" | "declared-threshold";

async function declaredAboveThreshold(d1: D1, run: PromotionRun): Promise<boolean> {
  const flag = (await d1.query("select value from feature_flags where key = ?", [DECLARED_THRESHOLD_FLAG])).rows[0]?.value;
  const threshold = typeof flag === "string" ? Number(JSON.parse(flag)) : DEFAULT_DECLARED_THRESHOLD;
  if (!Number.isFinite(threshold)) return false;
  const scan = (await d1.query("select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 1")).rows[0];
  if (!scan) return false;
  const declared = (await d1.query("select count(distinct repository) as n from pack_declarations where scan_id = ? and pack = ?", [scan.id, packOf(run)])).rows[0]?.n;
  return Number(declared ?? 0) > threshold;
}

/** Every reason a version that passed must wait for an owner's approval instead of being promoted, widening first. */
export async function stagingReasons(d1: D1, run: PromotionRun, verified: boolean, nowIso: string): Promise<StagingReason[]> {
  const reasons: StagingReason[] = [];
  if (run.widening === 1) reasons.push("widening");
  if (await hasPublisherChange(d1, run.scope_id, run.pack_name)) reasons.push("publisher-change");
  const last = (
    await d1.query(
      `select max(v.published_at) as at from pack_versions v join packs p on p.id = v.pack_id where p.scope_id = ? and p.name = ? and v.published_at is not null`,
      [run.scope_id, run.pack_name],
    )
  ).rows[0]?.at;
  if (typeof last === "string" && Date.parse(nowIso) - Date.parse(last) > DORMANT_DAYS * 86_400_000) reasons.push("dormant");
  if (verified) reasons.push("verified-publisher");
  if (await declaredAboveThreshold(d1, run)) reasons.push("declared-threshold");
  return reasons;
}
