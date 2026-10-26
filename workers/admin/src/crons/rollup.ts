import { runRollup } from "@packserver/core/stats";
import { createHasher, createTelemetry } from "@packserver/core/telemetry";
import type { CronJob } from "./index";

/** Folds the new Logpush objects and private download points into the fetch counts, once per hour. */
export const rollup: CronJob = async ({ ports, version }) => {
  const started = ports.clock.now();
  const summary = await runRollup({ d1: ports.d1, ops: ports.r2.OPS_BUCKET, clock: ports.clock, ...(ports.privateDownloads && { privateDownloads: ports.privateDownloads }) });
  const telemetry = createTelemetry({ worker: "admin", releaseId: version.releaseId, versionId: version.versionId, stats: ports.stats, clock: ports.clock, hasher: createHasher({}, ports.clock) });
  telemetry.emit("rollup.completed", { job: "fetches", ran: summary.ran.join(","), objects: summary.objects, skipped: summary.skipped, ignored: summary.ignored, private: summary.privateDownloads, rows: summary.folded, duration_ms: ports.clock.now() - started });
  console.log(JSON.stringify({ at: "cron.rollup", ...summary }));
};
