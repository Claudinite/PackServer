import type { Clock, Stats, StatsPoint } from "@packserver/ports";
import { clean, consoleLine, knownMethod, outcomeFor, UNKNOWN_DOUBLE, parseUserAgent, requestPoint, TIMINGS, type Outcome, type PrincipalKind, type Timing, type WideEvent } from "./event";
import { dedupeKey, scrubIp, type Hasher } from "./hashing";
import { logRate, type TelemetryMode } from "./sampling";
import type { SignalName } from "./signals";

export type SignalAttrs = Readonly<Record<string, string | number | boolean>>;

/** What a handler says about the request it is serving; everything else the recorder observes itself. */
export interface RequestFacts {
  /** Set by the code that authenticated the request. `synthetic` is the only source of `is_synthetic`. */
  principal?: { kind: PrincipalKind; id?: string };
  scope?: string;
  pack?: string;
  journey?: string;
  errorCode?: string;
  outcome?: Outcome;
  /** Only a request that says `public` keeps its scope and pack in the wide event; a private or unset one never names its scope or pack. */
  visibility?: "public" | "private";
  timings?: Partial<Record<Timing, number>>;
  cpuMs?: number;
}

export interface RequestObservation {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  ip?: string;
  country?: string;
  colo?: string;
  userAgent?: string | null;
  cacheStatus?: string;
  versionOverride: boolean;
  exception?: boolean;
  canceled?: boolean;
  facts: RequestFacts;
}

export const FETCHERS = ["cn_adopt", "cn_update", "mcp"] as const;
export type Fetcher = (typeof FETCHERS)[number];

/**
 * A fetch of a private pack, public or private repository alike: the caller was validated, so
 * who fetched what is kept for 90 days (REQ-TELEM-008) and shown only to the pack's owner. There
 * is deliberately no public variant: a public pack's fetches are counted from the zone's request
 * logs, by network, and the Worker records nothing that could follow a repository.
 */
export interface PrivateDownload {
  visibility: "private";
  pack: string;
  version: string;
  /** The opaque id the bytes are addressed by. */
  versionId: string;
  fetcher: Fetcher;
  principal: { kind: PrincipalKind; id: string };
  ip?: string;
  country?: string;
  userAgent?: string | null;
  /** From the OIDC claims of the fetch: the granted account and the repository. */
  repository?: { ownerId: string; name: string; visibility?: string };
  /** cn's opaque per-repository key; stored only as a keyed hash. */
  affinityKey?: string;
  bytes?: number;
}

/** Column order of the `downloads` point; `index1` is the version id. Append only. */
export const DOWNLOAD_BLOBS = [
  "pack", "version", "fetcher", "principal_kind", "principal_hash", "dedupe_key", "ip_hash", "country", "client_version",
  "repository_owner_id", "repository", "repository_visibility", "affinity_hash", "release_id", "worker",
] as const;
export const DOWNLOAD_DOUBLES = ["bytes", "count"] as const;

export interface TelemetryOptions {
  worker: string;
  releaseId: string;
  versionId: string;
  stats: Stats;
  clock: Clock;
  hasher: Hasher;
  /** The Workers Logs line sink. */
  log?: (line: string) => void;
}

export interface RecordedRequest {
  event: WideEvent;
  /** Whether the console line was written; the point always is. */
  logged: boolean;
  rate: number;
}

export interface Telemetry {
  /** A domain event named by its signal. */
  emit(signal: SignalName, attrs?: SignalAttrs): void;
  download(fact: PrivateDownload): Promise<StatsPoint>;
  request(observation: RequestObservation, policy: { mode: TelemetryMode; random: () => number }): Promise<RecordedRequest>;
}

/**
 * Fixed `doubles` columns per signal; a number not listed stays in the attributes blob. Append
 * only, so a column never changes meaning. A signal absent here has no doubles.
 */
export const SIGNAL_NUMBERS: Readonly<Partial<Record<SignalName, readonly string[]>>> = {
  "publish.received": ["bytes"],
  "search.query": ["results", "duration_ms"],
  "validation.step": ["duration_ms"],
  "queue.backlog": ["depth", "oldest_age_s"],
  "github.rate_limit_remaining": ["remaining"],
  "moderation.queue_age": ["age_s"],
  "rollup.completed": ["rows", "duration_ms"],
};

const OWN_WRITER = new Set<string>(["download.served", "http.request"]);

const nonNegative = (n: number | undefined): number | undefined => (n === undefined || !Number.isFinite(n) || n < 0 ? undefined : n);

const cleanAttrs = (attrs: SignalAttrs): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" ? scrubIp(v) : v]));

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const { worker, releaseId, versionId, stats, hasher } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    emit(signal, attrs = {}) {
      if (OWN_WRITER.has(signal)) throw new Error(`${signal} has its own writer and cannot be emitted as a domain event`);
      const safe = cleanAttrs(attrs);
      const doubles = (SIGNAL_NUMBERS[signal] ?? []).map((k) => (typeof safe[k] === "number" ? (safe[k] as number) : UNKNOWN_DOUBLE));
      stats.write({ name: signal, index: signal, blobs: [worker, releaseId, versionId, JSON.stringify(safe)], doubles });
    },

    async download(fact) {
      if ((fact as { visibility: string }).visibility !== "private") {
        throw new Error("a public download is counted from the zone's request logs, never recorded by a Worker");
      }
      const principalHash = await hasher.principal(fact.principal.kind, fact.principal.id);
      const dedupe = principalHash === undefined ? undefined : dedupeKey({ visibility: "private", principalHash }, fact.versionId, hasher.day());
      const values: Record<(typeof DOWNLOAD_BLOBS)[number], string | undefined> = {
        pack: fact.pack,
        version: fact.version,
        fetcher: fact.fetcher,
        principal_kind: fact.principal.kind,
        principal_hash: principalHash,
        dedupe_key: dedupe,
        ip_hash: fact.ip === undefined ? undefined : await hasher.ip(fact.ip),
        country: fact.country,
        client_version: parseUserAgent(fact.userAgent)?.client_version,
        repository_owner_id: fact.repository?.ownerId,
        repository: fact.repository?.name,
        repository_visibility: fact.repository?.visibility,
        affinity_hash: fact.affinityKey === undefined ? undefined : await hasher.affinity(fact.affinityKey),
        release_id: releaseId,
        worker,
      };
      const point: StatsPoint = {
        name: "download.served",
        index: fact.versionId,
        blobs: DOWNLOAD_BLOBS.map((k) => scrubIp(values[k] ?? "")),
        doubles: [nonNegative(fact.bytes) ?? UNKNOWN_DOUBLE, 1],
      };
      stats.write(point);
      return point;
    },

    async request(obs, policy) {
      const { facts } = obs;
      const principal = facts.principal ?? { kind: "anonymous" as const };
      const publicNames = facts.visibility === "public";
      const client = parseUserAgent(obs.userAgent);
      const principalHash = principal.id === undefined ? undefined : await hasher.principal(principal.kind, principal.id);
      const ipHash = obs.ip === undefined ? undefined : await hasher.ip(obs.ip);
      const outcome: Outcome = facts.outcome ?? (obs.canceled ? "canceled" : obs.exception ? "exception" : outcomeFor(obs.status));
      const event: WideEvent = {
        worker,
        "http.route": scrubIp(obs.route),
        method: knownMethod(obs.method),
        status: obs.status,
        outcome,
        journey: clean(facts.journey),
        error_code: clean(facts.errorCode),
        principal_kind: principal.kind,
        principal_hash: principalHash,
        scope: publicNames ? clean(facts.scope) : undefined,
        pack: publicNames ? clean(facts.pack) : undefined,
        client: client?.client,
        client_version: client?.client_version,
        ip_hash: ipHash,
        country: obs.country,
        duration_ms: obs.durationMs,
        cpu_ms: nonNegative(facts.cpuMs),
        version_id: versionId,
        release_id: releaseId,
        colo: obs.colo,
        cache_status: obs.cacheStatus,
        version_override: obs.versionOverride,
        is_synthetic: principal.kind === "synthetic",
      };
      for (const t of TIMINGS) event[t] = nonNegative(facts.timings?.[t]);
      stats.write(requestPoint(event));
      const rate = logRate({ worker, method: obs.method, status: obs.status, principalKind: principal.kind, mode: policy.mode });
      const logged = rate >= 1 || (rate > 0 && policy.random() < rate);
      if (logged) log(consoleLine(event));
      return { event, logged, rate };
    },
  };
}
