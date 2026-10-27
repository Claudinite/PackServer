import type { BurnCounts } from "@packserver/core/alerts";

/** The points of one signal with one attribute blob, counted over the spans the detectors use. */
export interface AlertRow {
  signal: string;
  attrs: string;
  /** Points in the last 30 minutes, the last hour and the last 24 hours. */
  n30m: number;
  n1h: number;
  n24h: number;
  /** Time of the newest point, in milliseconds. */
  ts: number;
  d1: number;
  d2: number;
}

/** A signal's count over the last hour and the last seven days, attributes ignored. */
export interface RateRow {
  signal: string;
  hour: number;
  week: number;
}

/** Read-path requests by serving version over each burn window. */
export interface BurnRow {
  version_id: string;
  counts: BurnCounts;
}

export interface AlertDataSource {
  events(nowMs: number): Promise<AlertRow[]>;
  rates(nowMs: number): Promise<RateRow[]>;
  burn(nowMs: number): Promise<BurnRow[]>;
}

/** Signals the detectors read as events, in the order of the table they answer. */
export const ALERT_SIGNALS = [
  "download.hash_mismatch",
  "moderation.quarantined",
  "publish.promoted",
  "moderation.report_prioritised",
  "moderation.takedown_completed",
  "index.key_changed",
  "audit.chain_broken",
  "queue.dlq",
  "queue.backlog",
  "auth.login_failed_burst",
  "workflow.instance_finished",
  "email.failed",
  "publish.oidc_rejected",
  "github.webhook_rejected",
  "abuse.daily_cap_hit",
] as const;

export const RATE_SIGNALS = ["publish.received"] as const;
