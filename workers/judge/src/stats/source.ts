/** Counts over one window, which runs from a stage start to now. */
export interface WindowCounts {
  samples: number;
  /** Server errors, exceptions and cancellations. */
  bad: number;
  downloads: number;
  /** Counts per latency bucket, `LATENCY_BOUNDS_MS` plus the open one. */
  latency: number[];
}

/**
 * One row of the request_outcomes totals: a version's requests under one source flag pair. The row
 * count follows versions, never clients; `windows` is aligned with `ReadWindow.starts`.
 */
export interface RequestGroup {
  version_id: string;
  worker: string;
  override: boolean;
  synthetic: boolean;
  /** Samples since the start of the UTC day. */
  today: number;
  /** Samples in the last 15 minutes, for the real-traffic rate. */
  recent: number;
  windows: WindowCounts[];
}

/** One heavy client of one version, by window. Only clients heavy enough to matter are listed. */
export interface TopClient {
  version_id: string;
  key: string;
  windows: Array<{ samples: number; bad: number }>;
}

export interface RequestData {
  groups: RequestGroup[];
  principals: TopClient[];
  ips: TopClient[];
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
  /** Distinct stage starts, oldest first, at most `MAX_WINDOWS`; the oldest bounds every read. */
  starts: number[];
  /** Start of the UTC day. */
  dayStartMs: number;
  /** Start of the "recent" span. */
  recentMs: number;
}

/** One read per dataset per cycle, with the concentration of clients read separately from the totals. */
export interface GateDataSource {
  requestOutcomes(window: ReadWindow): Promise<RequestData>;
  domainEvents(window: ReadWindow): Promise<DomainRow[]>;
  syntheticProbes(window: ReadWindow): Promise<ProbeRow[]>;
}

/** No stage reaches back further than the bake window. */
export const MAX_LOOKBACK_MS = 24 * 3_600_000;
export const RECENT_MS = 15 * 60_000;
export const MAX_WINDOWS = 6;

/** Windows for the given stage starts, each clipped to the lookback, oldest first. */
export function windowAt(nowMs: number, stageStarts: readonly number[]): ReadWindow {
  const floor = nowMs - MAX_LOOKBACK_MS;
  const distinct = [...new Set(stageStarts.map((s) => Math.max(s, floor)))].sort((a, b) => a - b);
  return { starts: (distinct.length > 0 ? distinct : [floor]).slice(0, MAX_WINDOWS), dayStartMs: nowMs - (nowMs % 86_400_000), recentMs: nowMs - RECENT_MS };
}

/** The index of the newest window that starts no later than `startMs`, so a stage is never given less than its own traffic. */
export function windowIndex(window: ReadWindow, startMs: number): number {
  const floored = Math.max(startMs, window.starts[0] as number);
  let found = 0;
  window.starts.forEach((s, i) => {
    if (s <= floored) found = i;
  });
  return found;
}
