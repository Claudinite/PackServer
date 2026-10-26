import type { D1 } from "@packserver/ports";

export type MilestoneOutcome = "ok" | "fail" | "skipped";

/**
 * Appends one milestone for a step, once. A step that runs again after a crash finds its own
 * milestone and adds nothing, so the dashboard's list never shows a step twice and the order
 * never changes.
 */
export async function milestone(d1: D1, runId: string, step: string, outcome: MilestoneOutcome, detail: string | null, at: string): Promise<void> {
  await d1.query(
    `insert into validation_milestones (run_id, seq, step, outcome, detail, at)
     select ?, (select coalesce(max(seq), 0) + 1 from validation_milestones where run_id = ?), ?, ?, ?, ?
     where not exists (select 1 from validation_milestones where run_id = ? and step = ?)`,
    [runId, runId, step, outcome, detail, at, runId, step],
  );
}

export async function milestoneOf(d1: D1, runId: string, step: string): Promise<{ outcome: MilestoneOutcome; detail: string | null } | null> {
  const rows = (await d1.query(`select outcome, detail from validation_milestones where run_id = ? and step = ?`, [runId, step])).rows;
  return (rows[0] as { outcome: MilestoneOutcome; detail: string | null } | undefined) ?? null;
}
