import { newFindings, reasonOf } from "@packserver/core/validation";
import { ValidationReport } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { getJson } from "../workflow/report";
import { RESCAN_PRINCIPAL, rescanUploadKey } from "../workflow/upload";
import { archiveKeyOf, originalFindings } from "./material";
import { quarantine } from "./quarantine";
import { candidateOf, type Candidate } from "./store";

const runIdOf = (candidate: Candidate, trigger: string): string => `rescan-${candidate.id}-${trigger}`;

/**
 * Starts the full pipeline over a published version: a dry-run of its committed archive under the
 * rescan principal, keyed on the version and the week so a second fire starts nothing. The run
 * creates no version and promotes nothing; a later fire applies its verdict.
 */
export async function startPipelineRun(rt: ValidatorRuntime, candidate: Candidate, trigger: string): Promise<{ started: boolean }> {
  const workflow = rt.ports.workflows.VALIDATE_PACK;
  if (!workflow) throw new Error("the VALIDATE_PACK binding is missing");
  const id = runIdOf(candidate, trigger);
  const at = new Date(rt.ports.clock.now()).toISOString();
  const size = (await rt.ports.d1.query(`select size_bytes from pack_versions where id = ?`, [candidate.id])).rows[0]?.size_bytes ?? 0;
  const [created] = await rt.ports.d1.batch([
    {
      sql: `insert or ignore into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, prose_screen, synthetic,
                                                    status, start_after, dispatched_at, created_at, updated_at)
            values (?, 'dry-run', 'upload', ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'running', ?, ?, ?, ?)`,
      params: [
        id, candidate.scope_id, candidate.pack.slice(candidate.pack.indexOf("/") + 1), candidate.version, RESCAN_PRINCIPAL, `rescan:${candidate.id}:${trigger}`,
        rescanUploadKey(candidate.visibility, archiveKeyOf(candidate)), candidate.sha256, size, at, at, at, at,
      ],
    },
    { sql: `insert or ignore into rescan_runs (run_id, version_id, trigger) values (?, ?, ?)`, params: [id, candidate.id, trigger] },
  ]);
  try {
    await workflow.create({ id, params: { run_id: id } });
  } catch {
    // The instance already exists: the same start arriving twice.
    await workflow.status(id);
  }
  return { started: (created?.meta.changes ?? 0) > 0 };
}

export interface Applied {
  applied: number;
  quarantined: number;
}

/**
 * Applies the verdicts of finished rescan runs. A `fail` was never promotable, so it quarantines. A
 * `hold` quarantines only for findings the version's original report did not carry (a person decided
 * those). An `error` is the platform's, not the pack's: it is recorded and the pack is judged next week.
 */
export async function applyPipelineResults(rt: ValidatorRuntime, limit: number): Promise<Applied> {
  const pending = await rt.ports.d1.query(
    `select rr.run_id, rr.version_id, v.verdict, v.report_key, v.reason
       from rescan_runs rr join validation_runs v on v.id = rr.run_id
      where rr.applied_at is null and v.status = 'finished' order by rr.run_id limit ?`,
    [limit],
  );
  const out: Applied = { applied: 0, quarantined: 0 };
  for (const row of pending.rows) {
    const candidate = await candidateOf(rt.ports.d1, String(row.version_id));
    if (candidate && row.verdict !== "error" && row.report_key !== null) {
      const report = ValidationReport.safeParse(await getJson(rt.ports.r2.VALIDATION_REPORTS!, String(row.report_key)));
      if (report.success) {
        const reason = reasonOf(newFindings(report.data.findings, await originalFindings(rt, candidate)));
        if (reason !== null && (await quarantine(rt, candidate, reason))) out.quarantined++;
      } else {
        console.log(JSON.stringify({ event: "validator.rescan_report_unreadable", run_id: String(row.run_id) }));
      }
    } else if (row.verdict === "error") {
      console.log(JSON.stringify({ event: "validator.rescan_run_errored", run_id: String(row.run_id), reason: String(row.reason) }));
    }
    await rt.ports.d1.query(`update rescan_runs set applied_at = ? where run_id = ?`, [new Date(rt.ports.clock.now()).toISOString(), row.run_id]);
    out.applied++;
  }
  return out;
}
