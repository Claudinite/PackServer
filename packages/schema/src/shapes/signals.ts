import { z } from "zod";

/** The signals catalogue: `<area>.<past-tense event>`. Append-only. */
export const SIGNALS = {
  download: ["served", "hash_mismatch", "hash_mismatch_reported"],
  index: ["served", "signed", "root_signed", "verify_failed", "verify_failed_reported", "key_changed", "stale", "stale_reported", "rollback_reported"],
  search: ["query", "degraded", "vectorize_error"],
  mcp: ["call", "auth_rejected"],
  oauth: ["flow"],
  publish: ["received", "oidc_exchanged", "oidc_rejected", "provenance_mismatch", "source_unverified", "quota_hit", "validated", "staged_waiting", "approved", "promoted", "failed"],
  validation: ["step", "sandbox_timeout", "tree_hash_mismatch", "prose_screen", "verdict_distribution"],
  rescan: ["completed"],
  moderation: ["report_received", "report_prioritised", "quarantined", "takedown_completed", "queue_age"],
  auth: ["login", "login_failed_burst", "stepup", "factor_changed", "recovery_requested", "session_revoked"],
  token: ["minted", "revoked", "leak_reported", "rejected"],
  scope: ["created", "proof_changed", "application_decided"],
  grant: ["changed"],
  admin: ["action"],
  cloudflare: ["audit_event"],
  github: ["webhook_received", "webhook_rejected", "rate_limit_remaining", "scan_completed"],
  email: ["sent", "failed"],
  queue: ["message_processed", "dlq", "backlog"],
  workflow: ["instance_finished", "wait_rearmed"],
  rollup: ["completed"],
  audit: ["appended", "batch_written", "chain_verified", "chain_broken"],
  abuse: ["rate_limited", "turnstile_failed", "anomaly_hold", "daily_cap_hit"],
  synthetic: ["probe"],
  selftest: ["result"],
  gate: ["evaluated"],
  budget: ["usage"],
  monitoring: ["heartbeat", "alert_sent", "alert_rejected", "page_test"],
} as const;

export type SignalArea = keyof typeof SIGNALS;
export type SignalName = {
  [A in SignalArea]: `${A}.${(typeof SIGNALS)[A][number]}`;
}[SignalArea];

export const SIGNAL_NAMES = Object.entries(SIGNALS).flatMap(([area, events]) =>
  events.map((event) => `${area}.${event}`),
) as readonly SignalName[];

export const SignalNameSchema = z.enum(SIGNAL_NAMES as [SignalName, ...SignalName[]]);

export const ANALYTICS_DATASETS = [
  "request_outcomes",
  "domain_events",
  "validation_events",
  "synthetic_probes",
  "gate_results",
  "budget",
  "downloads",
] as const;
export type AnalyticsDataset = (typeof ANALYTICS_DATASETS)[number];
