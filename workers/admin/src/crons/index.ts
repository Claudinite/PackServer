import type { AdminRuntime } from "../bindings";
import { auditHead } from "./audit-head";
import { auditVerify } from "./audit-verify";
import { community } from "./community";
import { domainRecheck } from "./domain-recheck";
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

export const CRON_HOURLY = "0 * * * *";
export const CRON_REPORTS = "30 * * * *";
export const CRON_DAILY = "0 3 * * *";

/** Each trigger in wrangler.jsonc runs exactly the jobs listed under it. */
export const CRON_JOBS: Readonly<Record<string, readonly CronJob[]>> = {
  [CRON_HOURLY]: [rollup, community, lifecycle, tokenLastUsed, githubProofLapse, syntheticExpiry, flagMirror],
  [CRON_REPORTS]: [reportNotices],
  [CRON_DAILY]: [prune, domainRecheck, auditHead, auditVerify, trending],
};

export async function runCron(cron: string, runtime: AdminRuntime): Promise<void> {
  const jobs = CRON_JOBS[cron];
  if (!jobs) throw new Error(`no jobs for cron "${cron}"`);
  const outcomes = await Promise.allSettled(jobs.map((job) => job(runtime)));
  const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
  if (failed.length > 0) throw new AggregateError(failed.map((f) => f.reason), `${failed.length} of ${jobs.length} jobs for "${cron}" failed`);
}
