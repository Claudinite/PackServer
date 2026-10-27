import { drainNotices, type NoticeDelivery } from "./notices.ts";
import type { ReportPorts } from "./ports.ts";
import { sweepReports, type SweepResult } from "./sweep.ts";

// One pass spends well under D1's per-invocation query budget: a report costs about two queries, a notice two.
export const REPORTS_PER_PASS = 100;
export const NOTICES_PER_PASS = 200;

/** What the scheduled job does each time it fires: the sweep, then the mail it queued. Whatever the bounds leave waits for the next pass. */
export async function reportPass(ports: ReportPorts, delivery: NoticeDelivery): Promise<SweepResult & { sent: number; skipped: number }> {
  const swept = await sweepReports(ports, { limit: REPORTS_PER_PASS });
  return { ...swept, ...(await drainNotices(ports, delivery, NOTICES_PER_PASS)) };
}
