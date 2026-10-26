import { hasPublisherChange } from "@packserver/core/publishing";
import type { D1 } from "@packserver/ports";

/** A validation run as promotion reads it: the verdict, the committed form and who stood behind it. */
export interface PromotionRun {
  id: string;
  kind: "publish" | "dry-run";
  source: "oidc" | "upload";
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
      `select r.id, r.kind, r.source, r.scope_id, s.name as scope, s.kind as scope_kind, r.pack_name, r.version, r.principal, r.credential_id, r.declared_sha256,
              r.status, r.verdict, r.widening, r.source_verified, r.score, r.rules_version, r.canonical_sha256, r.canonical_key, r.tree_hash, r.report_key, r.finished_at
         from validation_runs r join scopes s on s.id = r.scope_id where r.id = ?`,
      [runId],
    )
  ).rows[0];
  if (!row) throw new Error(`no validation run ${runId}`);
  return row as unknown as PromotionRun;
}

/** Whether a finished run may be promoted without anyone's decision: a publish that passed or only warned, and does not widen what the pack may do. */
export function promotable(run: PromotionRun): boolean {
  return (
    run.kind === "publish" &&
    run.status === "finished" &&
    (run.verdict === "pass" || run.verdict === "warn") &&
    run.widening !== 1 &&
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

export type StagingReason = "publisher-change" | "dormant" | "verified-publisher";

/** Why a version that passed must wait for an owner's approval instead of being promoted here, or null when it may go straight out. */
export async function stagingReason(d1: D1, run: PromotionRun, verified: boolean, nowIso: string): Promise<StagingReason | null> {
  if (await hasPublisherChange(d1, run.scope_id, run.pack_name)) return "publisher-change";
  const last = (
    await d1.query(
      `select max(v.published_at) as at from pack_versions v join packs p on p.id = v.pack_id where p.scope_id = ? and p.name = ? and v.published_at is not null`,
      [run.scope_id, run.pack_name],
    )
  ).rows[0]?.at;
  if (typeof last === "string" && Date.parse(nowIso) - Date.parse(last) > DORMANT_DAYS * 86_400_000) return "dormant";
  return verified ? "verified-publisher" : null;
}
