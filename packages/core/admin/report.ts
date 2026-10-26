import { ValidationReport } from "@packserver/schema";
import type { Finding } from "@packserver/schema";
import type { R2Read } from "@packserver/ports";

const decoder = new TextDecoder();

export async function readJson(bucket: R2Read, key: string): Promise<unknown | null> {
  const bytes = await bucket.get(key);
  return bytes ? (JSON.parse(decoder.decode(bytes)) as unknown) : null;
}

export interface AdminReportView {
  run_id: string;
  pack: string;
  version: string;
  verdict: string;
  rules_version: string;
  started_at: string;
  finished_at: string | null;
  score: number | null;
  source_verified: boolean;
  steps: Array<{ step: number; name: string; outcome: string }>;
  findings: Finding[];
  /** Which `ProseScreen` ran, and for a model screen where it tripped; never a probability or a threshold. */
  prose_screen: {
    implementation: string;
    question_set_version: string;
    model_version: string | null;
    tripped: Array<{ chunk: string; question: string }>;
  } | null;
}

const trippedOf = (admin: unknown): Array<{ chunk: string; question: string }> => {
  const list = (admin as { thresholds?: { tripped?: unknown } } | null)?.thresholds?.tripped;
  if (!Array.isArray(list)) return [];
  return list.flatMap((t) => (typeof t?.chunk === "string" && typeof t?.question === "string" ? [{ chunk: t.chunk, question: t.question }] : []));
};

/**
 * The full report as an admin reads it. Every field is copied by name from the stored report and the admin record,
 * so a number the pipeline keeps for calibration cannot reach the page by being added to either file.
 */
export async function adminReport(bucket: R2Read, runId: string, reportKey: string | null): Promise<AdminReportView | null> {
  const raw = await readJson(bucket, reportKey ?? `runs/${runId}/report.json`);
  if (!raw) return null;
  const report = ValidationReport.parse(raw);
  const admin = await readJson(bucket, `runs/${runId}/admin.json`);
  const implementation = (admin as { implementation?: unknown } | null)?.implementation;
  return {
    run_id: report.run_id,
    pack: report.pack,
    version: report.version,
    verdict: report.verdict,
    rules_version: report.rules_version,
    started_at: report.started_at,
    finished_at: report.finished_at,
    score: report.score,
    source_verified: report.source_verified,
    steps: report.steps.map((s) => ({ step: s.step, name: s.name, outcome: s.outcome })),
    findings: report.findings,
    prose_screen: report.prose_screen
      ? {
          implementation: typeof implementation === "string" ? implementation : report.prose_screen.implementation,
          question_set_version: report.prose_screen.question_set_version,
          model_version: report.prose_screen.model_version,
          tripped: trippedOf(admin),
        }
      : null,
  };
}
