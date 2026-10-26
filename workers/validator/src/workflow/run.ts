import type { D1 } from "@packserver/ports";

/** What the workflow reads of a run: everything but the bytes, which stay in staging. */
export interface RunInput {
  id: string;
  kind: "publish" | "dry-run";
  source: "oidc" | "upload";
  scope_id: string;
  scope: string;
  pack_name: string;
  version: string;
  principal: string;
  credential_id: string;
  staging_key: string;
  declared_sha256: string;
  size_bytes: number;
  prose_screen: number;
  synthetic: number;
  status: "queued" | "running" | "finished";
  start_after: string;
  queued_reason: string | null;
  created_at: string;
  dispatched_at: string | null;
  tree_hash: string | null;
  canonical_sha256: string | null;
  canonical_key: string | null;
}

export const packId = (run: Pick<RunInput, "scope" | "pack_name">): string => `@${run.scope}/${run.pack_name}`;

export async function readRun(d1: D1, runId: string): Promise<RunInput> {
  const rows = (
    await d1.query(
      `select r.id, r.kind, r.source, r.scope_id, s.name as scope, r.pack_name, r.version, r.principal, r.credential_id, r.staging_key, r.declared_sha256,
              r.size_bytes, r.prose_screen, r.synthetic, r.status, r.start_after, r.queued_reason, r.created_at, r.dispatched_at, r.tree_hash,
              r.canonical_sha256, r.canonical_key
         from validation_runs r join scopes s on s.id = r.scope_id where r.id = ?`,
      [runId],
    )
  ).rows;
  const run = rows[0] as unknown as RunInput | undefined;
  if (!run) throw new Error(`no validation run ${runId}`);
  return run;
}

/** The run's end: its verdict, why, where its report is, and the facts the report states. Written once; a run already finished is left as it is. */
export async function finishRun(
  d1: D1,
  runId: string,
  end: { verdict: "pass" | "warn" | "hold" | "fail" | "error"; reason: string | null; reportKey: string | null; sourceVerified: boolean | null; widening: boolean | null; score: number | null; rulesVersion: string },
  at: string,
): Promise<void> {
  await d1.query(
    `update validation_runs set status = 'finished', verdict = ?, reason = ?, report_key = ?, source_verified = ?, widening = ?, score = ?, rules_version = ?, finished_at = ?, updated_at = ?
      where id = ? and status != 'finished'`,
    [end.verdict, end.reason, end.reportKey, end.sourceVerified === null ? null : Number(end.sourceVerified), end.widening === null ? null : Number(end.widening), end.score, end.rulesVersion, at, at, runId],
  );
}
