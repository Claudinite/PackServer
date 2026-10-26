/** One row of the request_outcomes read: a version's requests from one (principal, ip) under one source flag pair. */
export interface RequestGroup {
  version_id: string;
  worker: string;
  override: boolean;
  synthetic: boolean;
  principal: string;
  ip: string;
  samples: number;
  bad: number;
  downloads: number;
  /** Samples since the start of the UTC day. */
  today: number;
  /** Samples in the last 15 minutes, for the real-traffic rate. */
  recent: number;
  /** Counts per latency bucket, `LATENCY_BOUNDS_MS` plus the open one. */
  latency: number[];
}

/** One row of the domain_events read: the points of one signal, from one emitting version, with one attribute blob. */
export interface DomainRow {
  signal: string;
  version_id: string;
  attrs: string;
  n: number;
  recent: number;
  ts: number;
  d1: number;
  d2: number;
}

export interface ProbeRow {
  attrs: string;
  n: number;
  ts: number;
}

export interface ReadWindow {
  sinceMs: number;
  /** Start of the UTC day. */
  dayStartMs: number;
  /** Start of the "recent" span. */
  recentMs: number;
}

/** One read per dataset per cycle; the judge reads nothing else. */
export interface GateDataSource {
  requestOutcomes(window: ReadWindow): Promise<RequestGroup[]>;
  domainEvents(window: ReadWindow): Promise<DomainRow[]>;
  syntheticProbes(window: ReadWindow): Promise<ProbeRow[]>;
}

/** The trailing span every read covers; a stage is at most a day long, and the bake window is a day. */
export const WINDOW_MS = 24 * 3_600_000;
export const RECENT_MS = 15 * 60_000;

export function windowAt(nowMs: number): ReadWindow {
  return { sinceMs: nowMs - WINDOW_MS, dayStartMs: nowMs - (nowMs % 86_400_000), recentMs: nowMs - RECENT_MS };
}
