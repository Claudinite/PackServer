import type { AdminRuntime } from "../bindings";
import { BudgetExhausted, queryBudget } from "./budget";
import { auditHead } from "./audit-head";
import { auditVerify } from "./audit-verify";
import { community } from "./community";
import { domainRecheck } from "./domain-recheck";
import { moderation } from "./moderation";
import { flagMirror } from "../flags/mirror";
import { githubProofLapse } from "./github-proof-lapse";
import { lifecycle } from "./lifecycle";
import { prune } from "./prune";
import { reportNotices } from "./report-notices";
import { rollup } from "./rollup";
import { syntheticExpiry } from "./synthetic-expiry";
import { tokenLastUsed } from "./token-last-used";
import { trending } from "./trending";

export type CronJob = (runtime: AdminRuntime) => Promise<void>;

/** D1 allows about 1000 queries in one invocation, and the jobs of a trigger share it; the shares under one trigger stay below it. */
export const INVOCATION_QUERIES = 900;

export const CRON_HOURLY = "0 * * * *";
export const CRON_ROLLUP = "15 * * * *";
export const CRON_REPORTS = "30 * * * *";
export const CRON_DAILY = "0 3 * * *";

/** Each trigger in wrangler.jsonc runs exactly the jobs listed under it. */
export const CRON_JOBS: Readonly<Record<string, readonly CronJob[]>> = {
  [CRON_ROLLUP]: [rollup],
  [CRON_HOURLY]: [community, lifecycle, moderation, tokenLastUsed, githubProofLapse, syntheticExpiry, flagMirror],
  [CRON_REPORTS]: [reportNotices],
  [CRON_DAILY]: [prune, domainRecheck, auditHead, auditVerify, trending],
};

/** Each hourly job's share of its trigger's D1 queries, set from the worst cases measured in cron-budget.test.ts; the daily jobs are not capped. */
export const JOB_QUERIES = new Map<CronJob, number>([
  [rollup, INVOCATION_QUERIES],
  [community, 280],
  [lifecycle, 230],
  [moderation, 130],
  [githubProofLapse, 170],
  [syntheticExpiry, 50],
  [tokenLastUsed, 10],
  [flagMirror, 10],
  [reportNotices, INVOCATION_QUERIES],
]);

/** Runs one job on a D1 that stops at its share; running out ends the job cleanly, and the next run resumes. */
async function runJob(job: CronJob, runtime: AdminRuntime): Promise<void> {
  const limit = JOB_QUERIES.get(job);
  if (limit === undefined) return job(runtime);
  const budget = queryBudget(runtime.ports.d1, limit);
  try {
    await job({ ...runtime, ports: { ...runtime.ports, d1: budget.d1 }, budget });
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    console.log(JSON.stringify({ at: "cron.budget_stopped", job: job.name, limit, used: budget.used() }));
  }
}

export async function runCron(cron: string, runtime: AdminRuntime): Promise<void> {
  const jobs = CRON_JOBS[cron];
  if (!jobs) throw new Error(`no jobs for cron "${cron}"`);
  const outcomes = await Promise.allSettled(jobs.map((job) => runJob(job, runtime)));
  const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
  if (failed.length > 0) throw new AggregateError(failed.map((f) => f.reason), `${failed.length} of ${jobs.length} jobs for "${cron}" failed`);
}
