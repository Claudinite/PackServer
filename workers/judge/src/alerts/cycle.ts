import type { Telemetry } from "@packserver/core/telemetry";
import type { IndexFetch, ReleaseRecord } from "@packserver/core/gates";
import type { Clock } from "@packserver/ports";
import type { Pager } from "../router/pushover";
import type { AlertRouter } from "../router/router";
import { ROUTER_KEYS, type RouterStore } from "../router/store";
import type { Dispatcher } from "../router/dispatch";
import { detect, type Detection } from "./detect";
import type { Platform } from "./platform";
import type { AlertDataSource } from "./source";

export interface AlertCycleDeps {
  clock: Clock;
  data: AlertDataSource;
  router: AlertRouter;
  dispatcher: Dispatcher;
  store: RouterStore;
  emit: Telemetry["emit"];
  pager: Pager;
  opsPageUrl: string;
  /** Absent where the Cloudflare API token is not configured; the polls are then skipped, not failed. */
  platform?: Platform;
  release: ReleaseRecord | null;
  mode: "pre-launch" | "launch";
  facts: {
    indexFetches: ReadonlyMap<string, readonly IndexFetch[]>;
    requestsToday: number;
    requestsPerSecond: number;
    audit: ReadonlyArray<{ id: string; signingKey: boolean }>;
    allowance: number;
    telemetryMode: string;
  };
}

export interface AlertRun {
  detections: number;
  raised: number;
  failures: string[];
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The alert half of the judge's cycle; every step fails on its own and is reported, so one broken input never silences the others. */
export async function runAlerts(deps: AlertCycleDeps): Promise<AlertRun> {
  const { clock, store, router, emit } = deps;
  const now = clock.now();
  const run: AlertRun = { detections: 0, raised: 0, failures: [] };
  const attempt = async <T>(step: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      run.failures.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  await attempt("budget", async () => {
    emit("budget.usage", {
      requests_today: deps.facts.requestsToday,
      log_allowance: deps.facts.allowance,
      log_share: deps.facts.allowance > 0 ? Math.round((deps.facts.requestsToday / deps.facts.allowance) * 1000) / 1000 : -1,
      telemetry_mode: deps.facts.telemetryMode,
    });
  });

  if (deps.platform) {
    await attempt("queue backlog", async () => {
        const queues = await (deps.platform as Platform).queueBacklogs(now);
        for (const q of queues) emit("queue.backlog", { queue: q.queue, depth: q.depth, ...(q.oldestAgeS === null ? {} : { oldest_age_s: q.oldestAgeS }) });
      });
  }
  const failingJobs = deps.platform ? await attempt("logpush", () => (deps.platform as Platform).failingLogpushJobs()) : null;

  const read = await attempt("alert reads", async () => {
    const [rows, rates, burn] = await Promise.all([deps.data.events(now), deps.data.rates(now), deps.data.burn(now)]);
    return { rows, rates, burn };
  });

  if (read) {
    const releaseId = deps.release?.release_id ?? null;
    const burningSince = releaseId === null ? null : await store.json<number>(ROUTER_KEYS.poll(`burning/${releaseId}`));
    const candidates = new Set(
      Object.values(deps.release?.workers ?? {}).flatMap((w) => (w?.changed === true && typeof w.version_id === "string" ? [w.version_id] : [])),
    );
    const detections: Detection[] = detect({
      now, release: deps.release, mode: deps.mode, rows: read.rows, rates: read.rates, burn: read.burn, indexFetches: deps.facts.indexFetches,
      candidates, requestsPerSecond: deps.facts.requestsPerSecond, burningSince, audit: deps.facts.audit,
    });
    if (failingJobs) {
      detections.push({ target: { kind: "ticket", ticket: "monitoring", key: "logpush" }, fields: { count: failingJobs, at: new Date(now).toISOString() }, actions: [] });
    }
    run.detections = detections.length;
    for (const detection of detections) {
      const raised = await attempt(`raise ${detection.target.kind === "page" ? detection.target.page : detection.target.ticket}`, () => router.raise(detection, deps.mode));
      if (raised && raised.delivered.length > 0) run.raised++;
    }
    const burningNow = detections.some((d) => d.target.kind === "page" && d.target.release?.candidateOnly === true);
    if (releaseId !== null) {
      if (burningNow && burningSince === null) await attempt("burn clock", () => store.putJson(ROUTER_KEYS.poll(`burning/${releaseId}`), now, 24 * 3600));
      if (!burningNow && burningSince !== null) await attempt("burn clock", () => store.putJson(ROUTER_KEYS.poll(`burning/${releaseId}`), null, 60));
    }
  }

  await attempt("deferred pages", () => router.drain());
  await attempt("mail outbox", () => deps.dispatcher.retryOutbox());
  await attempt("page test", async () => {
    const last = await store.json<string>(ROUTER_KEYS.pageTest);
    if (last === dayOf(now)) return;
    // The test goes straight to the phone, outside the router, so it never counts against the page cap or a dedupe.
    let ok = true;
    try {
      await deps.pager.send({ title: "monitoring.page_test", message: "Daily test of the path to your phone. Nothing is wrong.", url: deps.opsPageUrl, urlTitle: "Ops page", priority: -1 });
    } catch {
      ok = false;
    }
    emit("monitoring.page_test", { ok });
    await store.putJson(ROUTER_KEYS.pageTest, dayOf(now), 3 * 24 * 3600);
    if (!ok) {
      await router.raise({ target: { kind: "ticket", ticket: "monitoring", key: "page_test" }, fields: { at: new Date(now).toISOString() }, actions: [] }, deps.mode);
    }
  });
  return run;
}

