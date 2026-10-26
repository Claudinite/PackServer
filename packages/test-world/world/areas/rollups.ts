import { mismatchesOf, observeServerMismatch, packFetchStats, pruneFetches, recomputeStats, runRollup, utcDay, type MismatchListing, type PackFetchStats, type RollupSummary } from "@packserver/core/stats";
import type { D1, D1Result } from "@packserver/ports";
import type { Driver, SeedStorage } from "../../drivers/driver";
import { FakeDownloadPoints, LogpushArchive } from "../../fakes/logpush-archive";
import { createClock } from "../clock";
import { InfrastructureError } from "../errors";
import type { PackHandle } from "../packs";
import type { MintedToken } from "../tokens";

const DURATION = /^(\d+)(d|h|m)$/;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };

export interface DownloadOptions {
  /** The caller's address; only its network reaches the archive. */
  from?: string;
  /** This many callers, each in a /24 of its own, in place of `from`. */
  networks?: number;
  version?: string;
  /** How many requests; they are one record each. */
  times?: number;
  /** How long ago on the fake clock, e.g. `"31d"`. */
  ago?: string;
  /** `hits` is the sampled job, `misses` the unsampled one. */
  job?: "hits" | "misses";
}

export interface PrivateDownloadOptions {
  principal: string;
  version?: string;
  ago?: string;
}

export interface MismatchReportOptions {
  /** The caller's read token; omitted, the report is unauthenticated. */
  token?: MintedToken;
  version?: string;
  /** The hash the client expected; the registry's own by default. */
  expected?: string;
  observed?: string;
  kind?: "hash" | "signature";
  /** Sends exactly this body in place of the one built from the other options. */
  body?: unknown;
}

export interface MismatchCase {
  version: string;
  trigger: "reports" | "server" | "review";
  pagedAt: string | null;
}

/** The fetch-count rollup, the Logpush archive it reads and the mismatch reports clients send. */
export interface RollupsModule {
  rollups: {
    /** Public downloads delivered to the Logpush archive as the Transformer leaves them. */
    download(pack: PackHandle, o: DownloadOptions): Promise<void>;
    /** A private download as the serving Worker's analytics point records it. */
    privateDownload(pack: PackHandle, o: PrivateDownloadOptions): Promise<void>;
    /** One run of the hourly rollup at the fake clock's time; `private: false` leaves the analytics read unconfigured. */
    run(o?: { private?: boolean }): Promise<RollupSummary>;
    /** The daily pass that ages the windows. */
    ageWindows(): Promise<void>;
    stats(pack: PackHandle): Promise<PackFetchStats>;
    /** The counted fetches of each version on each UTC day. */
    perDay(pack: PackHandle): Promise<Array<{ version: string; day: string; fetches: number }>>;
  };
  mismatches: {
    /** What cn posts to `/api/report/hash-mismatch`; the answer is the same whatever happened. */
    report(pack: PackHandle, o?: MismatchReportOptions): Promise<{ accepted: boolean }>;
    /** The trust dashboard's listing for the pack. */
    listing(pack: PackHandle): Promise<MismatchListing[]>;
    /** Versions held for a mismatch, with when the page signal went out. */
    cases(pack: PackHandle): Promise<MismatchCase[]>;
    /** The serving Worker saw the archive's bytes differ from the recorded hash. */
    observedByServer(pack: PackHandle, version: string): Promise<{ quarantined: boolean }>;
    /** The pack's owners switch it to private; a seeded state change, since the verb needs a sensitive-action assertion. */
    makePrivate(pack: PackHandle): Promise<void>;
  };
}

/** Every address starts at its own, so one scenario's reports never spend another's minute. */
function freshAddress(): string {
  const [a = 0, b = 0] = crypto.getRandomValues(new Uint8Array(2));
  return `198.19.${a}.${b}`;
}

export function createRollups(driver: Driver): RollupsModule {
  const clock = createClock(driver);
  const points = new FakeDownloadPoints();
  let storagePromise: Promise<SeedStorage> | undefined;
  const storage = (): Promise<SeedStorage> => {
    if (!driver.storage || !driver.capabilities.has("storage")) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam, so it cannot reach the registry database or the ops bucket`);
    return (storagePromise ??= driver.storage());
  };
  const ops = async () => {
    const bucket = (await storage()).ops;
    if (!bucket) throw new InfrastructureError("the admin Worker is not booted, so there is no ops bucket");
    return bucket;
  };

  type Statement = { all(): Promise<{ results?: Array<Record<string, unknown>>; meta?: { changes?: number; last_row_id?: number } }> };
  const asResult = (out: Awaited<ReturnType<Statement["all"]>>): D1Result => ({ rows: out.results ?? [], meta: { changes: out.meta?.changes ?? 0, last_row_id: out.meta?.last_row_id ?? null } });
  const d1 = async (): Promise<D1> => {
    const { db } = await storage();
    const prepare = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params) as Statement;
    return {
      query: async (sql, params) => asResult(await prepare(sql, params).all()),
      batch: async (statements) => (await db.batch(statements.map((s) => prepare(s.sql, s.params)))).map((r) => asResult(r as Awaited<ReturnType<Statement["all"]>>)),
    };
  };
  const ago = async (duration: string | undefined): Promise<number> => {
    const now = (await clock.now()).getTime();
    if (duration === undefined) return now;
    const m = DURATION.exec(duration);
    if (!m) throw new InfrastructureError(`not a duration: ${duration} (use e.g. 31d)`);
    return now - Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  };
  const archive = async () => {
    const bucket = await ops();
    return new LogpushArchive({ put: (key, body) => bucket.put(key, body) });
  };
  const fixedClock = async () => {
    const at = (await clock.now()).getTime();
    return { now: () => at };
  };
  const depsFor = async () => {
    const bucket = await ops();
    return {
      d1: await d1(),
      clock: await fixedClock(),
      ops: {
        async get(key: string) {
          const object = await bucket.get(key);
          return object ? new Uint8Array(await object.arrayBuffer()) : null;
        },
        async head(key: string) {
          const object = await bucket.get(key);
          return object ? { size: (await object.arrayBuffer()).byteLength } : null;
        },
        async list(prefix: string) {
          const keys: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
            keys.push(...page.objects.map((o) => o.key));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          return keys;
        },
      },
    };
  };

  const idOf = (): (() => string) => () => crypto.randomUUID();
  const registryHash = async (pack: PackHandle, version: string): Promise<string> => {
    const { rows } = await (await d1()).query(
      `select pv.sha256 as sha256 from pack_versions pv join packs p on p.id = pv.pack_id join scopes s on s.id = p.scope_id where '@' || s.name || '/' || p.name = ? and pv.version = ?`,
      [pack.systemName, version],
    );
    return String(rows[0]?.sha256);
  };

  return {
    rollups: {
      async download(pack, o) {
        const at = await ago(o.ago);
        const base = { pack: pack.systemName, version: o.version ?? "1.0.0", at, job: o.job ?? "misses" } as const;
        const callers = o.networks !== undefined ? Array.from({ length: o.networks }, (_, i) => `203.${Math.floor(i / 250)}.${i % 250}.9`) : [o.from ?? "198.51.100.7"];
        await (await archive()).deliver(callers.flatMap((from) => Array.from({ length: o.times ?? 1 }, () => ({ ...base, from }))), (await clock.now()).getTime());
      },
      async privateDownload(pack, o) {
        points.record({ pack: pack.systemName, version: o.version ?? "1.0.0", day: utcDay(await ago(o.ago)), principal: o.principal });
      },
      async run(o = {}) {
        return runRollup({ ...(await depsFor()), ...(o.private === false ? {} : { privateDownloads: points.reader }) });
      },
      async ageWindows() {
        const connection = await d1();
        const now = (await clock.now()).getTime();
        await pruneFetches(connection, utcDay(now));
        await recomputeStats(connection, utcDay(now), new Date(now).toISOString());
      },
      async stats(pack) {
        return packFetchStats(await d1(), pack.systemName);
      },
      async perDay(pack) {
        const { rows } = await (await d1()).query(
          `select f.version, f.day, sum(f.weight) as fetches from fetch_days f join packs p on p.id = f.pack_id join scopes s on s.id = p.scope_id
            where '@' || s.name || '/' || p.name = ? group by f.version, f.day order by f.day, f.version`,
          [pack.systemName],
        );
        return rows.map((r) => ({ version: String(r.version), day: String(r.day), fetches: Number(r.fetches) }));
      },
    },
    mismatches: {
      async report(pack, o = {}) {
        const version = o.version ?? "1.0.0";
        const body = o.body ?? { pack: pack.systemName, version, kind: o.kind ?? "hash", expected: o.expected ?? (await registryHash(pack, version)), observed: o.observed ?? "f".repeat(64) };
        const res = await driver.http.request({
          surface: "web",
          method: "POST",
          path: "/api/report/hash-mismatch",
          headers: { "content-type": "application/json", "user-agent": "cn/1.0.0", "cf-connecting-ip": freshAddress(), ...(o.token ? { authorization: `Bearer ${o.token.value}` } : {}) },
          body,
        });
        return { accepted: res.status === 202 };
      },
      async listing(pack) {
        return mismatchesOf(await d1(), pack.systemName);
      },
      async cases(pack) {
        const { rows } = await (await d1()).query(
          `select c.version, c.trigger, c.paged_at from hash_mismatch_cases c join packs p on p.id = c.pack_id join scopes s on s.id = p.scope_id
            where '@' || s.name || '/' || p.name = ? order by c.version`,
          [pack.systemName],
        );
        return rows.map((r) => ({ version: String(r.version), trigger: r.trigger as MismatchCase["trigger"], pagedAt: r.paged_at === null ? null : String(r.paged_at) }));
      },
      async makePrivate(pack) {
        await (await d1()).query("update packs set visibility = 'private' where id = (select p.id from packs p join scopes s on s.id = p.scope_id where '@' || s.name || '/' || p.name = ?)", [pack.systemName]);
      },
      async observedByServer(pack, version) {
        return observeServerMismatch({ d1: await d1(), clock: await fixedClock(), id: idOf() }, { pack: pack.systemName, version });
      },
    },
  };
}
