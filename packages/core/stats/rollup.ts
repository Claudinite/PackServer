import type { Clock, D1, R2Read } from "@packserver/ports";
import { daysBefore, utcDay, utcHour, windowStarts } from "./days";
import { foldFetches, recomputeStats, type FetchRow } from "./fetches";
import { compactDay, gunzipIfNeeded, LOG_JOBS, parseLog } from "./logpush";

/** Archive objects folded per job per run; a backlog drains over the following runs. */
export const MAX_OBJECTS_PER_RUN = 200;

/** Private downloads the serving Worker recorded since `sinceDay`, one row per distinct (pack, version, day, principal). */
export type PrivateDownloads = (sinceDay: string) => Promise<Array<{ pack: string; version: string; day: string; principal: string }>>;

export interface RollupDeps {
  d1: D1;
  /** The `ops` bucket, read only. */
  ops: R2Read;
  clock: Clock;
  /** Absent where the Analytics Engine read is not configured; private counts are then left as they were. */
  privateDownloads?: PrivateDownloads;
}

export interface RollupSummary {
  hour: string;
  /** Jobs that ran; a job already finished for this hour is not in it. */
  ran: string[];
  objects: number;
  folded: number;
  ignored: number;
  skipped: number;
  packs: number;
  privateDownloads: "folded" | "not_configured";
}

/** Where a job resumes: the day before its last finished run, or the oldest window the first time. */
async function sinceDay(d1: D1, job: string, today: string): Promise<string> {
  const oldest = windowStarts(today).oldest;
  const { rows } = await d1.query("select max(hour) as hour from rollup_runs where job = ?", [job]);
  const last = rows[0]?.hour;
  if (typeof last !== "string") return oldest;
  const since = daysBefore(last.slice(0, 10), 1);
  return since < oldest ? oldest : since;
}

async function pendingObjects(deps: RollupDeps, prefix: string, job: string, since: string, today: string): Promise<string[]> {
  const keys: string[] = [];
  for (let day = since; day <= today; day = daysBefore(day, -1)) keys.push(...(await deps.ops.list(`${prefix}${compactDay(day)}/`)));
  keys.sort();
  if (keys.length === 0) return [];
  const { rows } = await deps.d1.query("select object_key from rollup_files where job = ? and object_key >= ?", [job, keys[0]]);
  const done = new Set(rows.map((r) => String(r.object_key)));
  return keys.filter((k) => !done.has(k)).slice(0, MAX_OBJECTS_PER_RUN);
}

/**
 * The hourly rollup: folds new archive objects and private download points into `fetch_days`,
 * then rewrites each pack's fetch counts. A job finished for the current hour is skipped, so a
 * duplicate trigger counts nothing twice, and every fold is itself idempotent.
 */
export async function runRollup(deps: RollupDeps): Promise<RollupSummary> {
  const now = deps.clock.now();
  const hour = utcHour(now);
  const today = utcDay(now);
  const nowIso = new Date(now).toISOString();
  const summary: RollupSummary = { hour, ran: [], objects: 0, folded: 0, ignored: 0, skipped: 0, packs: 0, privateDownloads: "not_configured" };
  const finished = new Set((await deps.d1.query("select job from rollup_runs where hour = ?", [hour])).rows.map((r) => String(r.job)));
  const complete = (job: string, files: number, rows: number) =>
    deps.d1.query("insert or replace into rollup_runs (job, hour, files, rows, completed_at) values (?, ?, ?, ?, ?)", [job, hour, files, rows, nowIso]);

  for (const { job, prefix, weight } of LOG_JOBS) {
    if (finished.has(job)) continue;
    const objects = await pendingObjects(deps, prefix, job, await sinceDay(deps.d1, job, today), today);
    let folded = 0;
    for (const key of objects) {
      const bytes = await deps.ops.get(key);
      if (bytes === null) continue;
      const parsed = parseLog(await gunzipIfNeeded(bytes));
      const rows: FetchRow[] = parsed.fetches.map((f) => ({ pack: f.pack, version: f.version, day: f.day, caller: `net:${f.network}`, weight }));
      const result = await foldFetches(deps.d1, "public", rows);
      await deps.d1.query("insert or ignore into rollup_files (job, object_key, processed_at) values (?, ?, ?)", [job, key, nowIso]);
      folded += result.folded;
      summary.ignored += result.ignored;
      summary.skipped += parsed.skipped;
    }
    await complete(job, objects.length, folded);
    summary.ran.push(job);
    summary.objects += objects.length;
    summary.folded += folded;
  }

  if (deps.privateDownloads) {
    summary.privateDownloads = "folded";
    if (!finished.has("downloads")) {
      const points = await deps.privateDownloads(await sinceDay(deps.d1, "downloads", today));
      const result = await foldFetches(deps.d1, "private", points.map((p) => ({ pack: p.pack, version: p.version, day: p.day, caller: `principal:${p.principal}`, weight: 1 })));
      await complete("downloads", 0, result.folded);
      summary.ran.push("downloads");
      summary.folded += result.folded;
      summary.ignored += result.ignored;
    }
  }

  if (summary.ran.length > 0) summary.packs = await recomputeStats(deps.d1, today, nowIso);
  return summary;
}
