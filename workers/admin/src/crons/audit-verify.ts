import { verifyAuditChain } from "@packserver/core/audit";
import type { CronJob } from "./index";

export const auditVerify: CronJob = async ({ ports }) => {
  const report = await verifyAuditChain({
    auditBucket: ports.auditBucket, d1: ports.d1, stats: ports.stats, clock: ports.clock,
    ...(ports.appendedPoints && { appendedPoints: ports.appendedPoints }),
  });
  console.log(JSON.stringify({ at: "cron.audit-verify", batches: report.batches, events: report.events, reconciledWith: report.reconciledWith, problems: report.problems.length }));
};
