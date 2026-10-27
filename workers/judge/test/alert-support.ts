import type { SupportWindow } from "@packserver/core/alerts";
import { CANDIDATE_MIRROR_KEY, type Clock } from "@packserver/ports";
import type { FakePorts } from "@packserver/ports/fakes";
import type { AlertCycleDeps } from "../src/alerts/cycle";
import type { Platform, ScriptBinding } from "../src/alerts/platform";
import type { AlertDataSource, AlertRow, BurnRow, RateRow } from "../src/alerts/source";
import { signalEmitter } from "../src/heartbeat/emit";
import { dispatcher, type DispatchConfig } from "../src/router/dispatch";
import type { Pager, Push } from "../src/router/pushover";
import { alertRouter } from "../src/router/router";
import { routerStore } from "../src/router/store";
import { FakeAdmin, judgeFakes } from "./support";

export const ARIEL = "ariel-user-key";
export const WINDOW: SupportWindow = { startHour: 7, endHour: 19 };

export class FakeAlertData implements AlertDataSource {
  rows: AlertRow[] = [];
  rateRows: RateRow[] = [];
  burnRows: BurnRow[] = [];
  async events() { return this.rows; }
  async rates() { return this.rateRows; }
  async burn() { return this.burnRows; }
}

/** Records pushes the way Pushover would: it can reach one user only. */
export class FakePager implements Pager {
  all: Push[] = [];
  recipients: string[] = [];
  failing = false;
  /** The pages and nothing else; the quiet daily test is `quiet`. */
  get pushes(): Push[] {
    return this.all.filter((p) => p.priority >= 0);
  }
  get quiet(): Push[] {
    return this.all.filter((p) => p.priority < 0);
  }
  async send(push: Push) {
    if (this.failing) throw new Error("Pushover answered 500");
    this.all.push(push);
    this.recipients.push(ARIEL);
  }
}

export class FakePlatform implements Platform {
  queues: Array<{ queue: string; depth: number; oldestAgeS: number | null }> = [];
  failingJobs: number | null = 0;
  /** Bindings by script name, as the account would return them. */
  scripts = new Map<string, ScriptBinding[]>();
  readScripts: string[] = [];
  async queueBacklogs() { return this.queues; }
  async failingLogpushJobs() { return this.failingJobs; }
  async scriptBindings(script: string) {
    this.readScripts.push(script);
    return this.scripts.get(script) ?? [];
  }
}

export const row = (signal: string, attrs: Record<string, unknown>, patch: Partial<AlertRow> = {}): AlertRow => ({
  signal, attrs: JSON.stringify(attrs), n30m: 1, n1h: 1, n24h: 1, ts: 0, d1: -1, d2: -1, ...patch,
});

export const DISPATCH: DispatchConfig = {
  opsEmail: "ops@example.test",
  opsPageUrl: "https://admin.example.test/ops",
  publicOrigin: "https://registry.example.test",
  muteKey: async () => "mute-key",
};

export function alertHarness(patch: { fakes?: FakePorts; admin?: FakeAdmin; strictKv?: boolean } = {}) {
  const fakes = patch.fakes ?? judgeFakes();
  const admin = patch.admin ?? new FakeAdmin();
  const pager = new FakePager();
  const data = new FakeAlertData();
  const platform = new FakePlatform();
  const kv = fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  if (patch.strictKv) {
    // Workers KV answers 429 to a second write to one key within a second.
    const lastWrite = new Map<string, number>();
    const put = kv.put.bind(kv);
    kv.put = async (key, value, options) => {
      const at = fakes.clock.now();
      const before = lastWrite.get(key);
      if (before !== undefined && at - before < 1000) throw new Error(`KV PUT failed: 429 for ${key}`);
      lastWrite.set(key, at);
      return put(key, value, options);
    };
  }
  const telemetryKv = fakes.kv["TELEMETRY_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  const store = routerStore(kv);
  const emit = signalEmitter({ releaseId: "rel", versionId: "judge-1", clock: fakes.clock as Clock, stats: fakes.stats, telemetry: fakes.telemetry });
  const out = dispatcher({ pager, mail: fakes.mail, config: DISPATCH, store, emit });
  const router = alertRouter({ clock: fakes.clock, store, dispatcher: out, admin, emit, window: WINDOW });
  const cycleDeps = (patchDeps: Partial<AlertCycleDeps> = {}): AlertCycleDeps => ({
    clock: fakes.clock,
    data,
    router,
    dispatcher: out,
    store,
    emit,
    pager,
    opsPageUrl: DISPATCH.opsPageUrl,
    platform,
    release: null,
    mode: "launch",
    facts: { indexFetches: new Map(), requestsToday: 0, requestsPerSecond: 5, audit: { pageworthyIds: [], bindingChecks: [] }, allowance: 1000, telemetryMode: "normal" },
    ...patchDeps,
  });
  const signals = (name: string) => fakes.stats.points.filter((p) => p.name === name).map((p) => ({ ...p, attrs: JSON.parse(p.blobs[3] ?? "{}") as Record<string, unknown> }));
  const setRelease = (release: object | null) => (release === null ? telemetryKv.delete(CANDIDATE_MIRROR_KEY) : telemetryKv.put(CANDIDATE_MIRROR_KEY, JSON.stringify(release)));
  return { fakes, admin, pager, data, platform, store, emit, dispatcher: out, router, cycleDeps, signals, setRelease };
}

/** Noon UTC on the fake clock's day, inside the support window. */
export function toHour(clock: { now(): number; advance(by: number): void }, hour: number): void {
  const d = new Date(clock.now());
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0);
  clock.advance(target - clock.now());
}
