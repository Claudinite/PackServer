import {
  firedTiers, holdEligibility, overdueReports, sumCounts, type AlertFields, type BurnCounts, type PageId, type PrioritisedReport, type ReleaseContext, type TicketKind,
} from "@packserver/core/alerts";
import type { IndexFetch, ReleaseRecord } from "@packserver/core/gates";
import type { AdminRequest } from "@packserver/schema";
import type { AlertRow, BurnRow, RateRow } from "./source";

export type Target = { kind: "page"; page: PageId; key: string; release?: ReleaseContext } | { kind: "ticket"; ticket: TicketKind; key: string };

/**
 * One thing the judge found wrong. The actions are taken before it is delivered, once per `actionKey`,
 * so the page can say they are done; delivery is the router's.
 */
export interface Detection {
  target: Target;
  fields: AlertFields;
  actions: AdminRequest[];
  actionKey?: string;
}

export interface DetectContext {
  now: number;
  release: ReleaseRecord | null;
  mode: "pre-launch" | "launch";
  rows: readonly AlertRow[];
  rates: readonly RateRow[];
  burn: readonly BurnRow[];
  indexFetches: ReadonlyMap<string, readonly IndexFetch[]>;
  /** Ids of the versions a rollout in flight is trying out. */
  candidates: ReadonlySet<string>;
  /** Real read-path requests a second over the last quarter hour. */
  requestsPerSecond: number;
  /** When this release's candidate-only burn was first seen, so the controller is given ten minutes; null when it has not been. */
  burningSince: number | null;
  /** Page-list audit events from this cycle's poll. */
  audit: ReadonlyArray<{ id: string; signingKey: boolean }>;
}

export const FLOOD_FACTOR = 20;
/** A flood below this many publishes in the hour is not one, whatever the baseline. */
export const FLOOD_FLOOR = 50;
export const STALL_MS = 30 * 60_000;
export const INDEX_STALE_AFTER_PROMOTION_MS = 10 * 60_000;
export const INDEX_STALE_ANYTIME_S = 24 * 3600;
export const WORKFLOW_FAILURE_SHARE = 0.05;
export const WORKFLOW_MIN_INSTANCES = 20;
const AUDIT_BACKLOG_S = 5 * 60;
const QUEUE_BACKLOG_S = 10 * 60;

function parse(attrs: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(attrs);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const by = (rows: readonly AlertRow[], signal: string): Array<AlertRow & { a: Record<string, unknown> }> =>
  rows.filter((r) => r.signal === signal).map((r) => ({ ...r, a: parse(r.attrs) }));

const sum = (rows: ReadonlyArray<{ n30m: number }>): number => rows.reduce((s, r) => s + r.n30m, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

export function detect(ctx: DetectContext): Detection[] {
  const out: Detection[] = [];
  const page = (page: PageId, key: string, fields: AlertFields, actions: AdminRequest[] = [], more: { release?: ReleaseContext; actionKey?: string } = {}): void => {
    out.push({
      target: { kind: "page", page, key, ...(more.release ? { release: more.release } : {}) },
      fields: { at: iso(ctx.now), ...fields },
      actions,
      ...(more.actionKey ? { actionKey: more.actionKey } : {}),
    });
  };
  const ticket = (ticket: TicketKind, key: string, fields: AlertFields, actions: AdminRequest[] = [], actionKey?: string): void => {
    out.push({ target: { kind: "ticket", ticket, key }, fields: { at: iso(ctx.now), ...fields }, actions, ...(actionKey ? { actionKey } : {}) });
  };

  // A mismatch the serving Worker saw is quarantined where the signal names the version.
  for (const r of by(ctx.rows, "download.hash_mismatch")) {
    if (r.n30m <= 0) continue;
    const pack = str(r.a.pack);
    const version = str(r.a.version);
    const named = pack !== null && version !== null;
    const id = str(r.a.version_id) ?? `${pack}@${version}`;
    // A private pack's name never reaches a log, so its signal carries an opaque id and the admin API cannot be asked.
    page("page.hash_mismatch", `hash_mismatch|${id}`, { count: r.n30m, ...(named ? {} : { noAction: "version_not_named" as const }) }, named ? [{ method: "quarantine_version", pack, version, reason: "server-observed hash mismatch" }] : [], { actionKey: `quarantine|${id}` });
  }
  // Two covering principals reporting a private version is quarantined by the serving Worker; the page is the judge's.
  for (const r of by(ctx.rows, "moderation.quarantined")) {
    if (r.n30m > 0 && r.a.reason === "hash_mismatch_reports") page("page.hash_mismatch", `hash_mismatch_reports|${r.attrs}`, { count: r.n30m });
  }
  if (sum(by(ctx.rows, "index.key_changed")) > 0) page("page.index_key_changed", "index_key_changed", { count: sum(by(ctx.rows, "index.key_changed")) });

  const chain = sum(by(ctx.rows, "audit.chain_broken"));
  const auditDlq = sum(by(ctx.rows, "queue.dlq").filter((r) => (str(r.a.queue) ?? "").startsWith("audit")));
  if (chain + auditDlq > 0) page("page.audit_pipeline", "audit_pipeline", { count: chain + auditDlq });

  if (by(ctx.rows, "auth.login_failed_burst").some((r) => r.n30m > 0 && r.a.past_locks === true)) page("page.credential_stuffing", "credential_stuffing", {});

  for (const event of ctx.audit) page(event.signingKey ? "page.signing_key_read" : "page.account_change", `audit|${event.id}`, {});

  if (ctx.release?.state === "rollback_failed") page("page.rollback_failed", `rollback_failed|${ctx.release.release_id}`, {});
  if (ctx.release?.state === "rolled_back") ticket("canary_rolled_back", `rolled_back|${ctx.release.release_id}`, {});

  indexPages(ctx, page);
  publishStalled(ctx, page);
  takedown(ctx, page);
  burn(ctx, page, ticket);
  tickets(ctx, ticket);
  return out;
}

type PageSink = (page: PageId, key: string, fields: AlertFields, actions?: AdminRequest[], more?: { release?: ReleaseContext; actionKey?: string }) => void;
type TicketSink = (ticket: TicketKind, key: string, fields: AlertFields, actions?: AdminRequest[], actionKey?: string) => void;

function indexPages(ctx: DetectContext, page: PageSink): void {
  const promoted = Math.max(0, ...by(ctx.rows, "publish.promoted").map((r) => r.ts));
  for (const [version, fetches] of ctx.indexFetches) {
    if (ctx.candidates.has(version) || fetches.length === 0) continue;
    const latest = fetches[fetches.length - 1] as IndexFetch;
    const previous = fetches[fetches.length - 2];
    if (!latest.ok && previous && !previous.ok) page("page.index_signature", "index_signature", {});
    if (latest.staleS === null) continue;
    const generated = latest.at - latest.staleS * 1000;
    const staleAfterPromotion = promoted > 0 && generated < promoted && latest.at - promoted > INDEX_STALE_AFTER_PROMOTION_MS;
    if (staleAfterPromotion || latest.staleS > INDEX_STALE_ANYTIME_S) page("page.index_stale", "index_stale", {});
  }
}

function publishStalled(ctx: DetectContext, page: PageSink): void {
  const slow = by(ctx.rows, "queue.backlog").some((r) => (str(r.a.queue) ?? "").includes("validat") && r.d2 >= STALL_MS / 1000 && ctx.now - r.ts < 15 * 60_000);
  const finished = by(ctx.rows, "workflow.instance_finished");
  const total = finished.reduce((s, r) => s + r.n1h, 0);
  const failed = finished.filter((r) => r.a.status === "errored" || r.a.status === "failed").reduce((s, r) => s + r.n1h, 0);
  const failing = total >= WORKFLOW_MIN_INSTANCES && failed / total > WORKFLOW_FAILURE_SHARE;
  if (slow || failing) page("page.publish_stalled", "publish_stalled", { count: failing ? failed : undefined });
}

function takedown(ctx: DetectContext, page: PageSink): void {
  const prioritised: PrioritisedReport[] = [];
  const declared = new Map<string, unknown>();
  for (const r of by(ctx.rows, "moderation.report_prioritised")) {
    const id = str(r.a.report);
    const pack = str(r.a.pack);
    const version = str(r.a.version);
    if (!id || !pack || !version) continue;
    prioritised.push({ id, pack, version, at: r.ts });
    declared.set(id, r.a.declared_by);
  }
  const decided = new Set([...by(ctx.rows, "moderation.takedown_completed"), ...by(ctx.rows, "moderation.quarantined")].flatMap((r) => str(r.a.report) ?? []));
  for (const report of overdueReports(prioritised, decided, new Set(), ctx.now)) {
    // REQ-MOD-009: only a version the signal says is declared by 100 repositories or fewer is held without a person.
    const eligibility = holdEligibility(declared.get(report.id));
    const key = `takedown|${report.id}`;
    if (eligibility !== "eligible") {
      page("page.takedown_overdue", key, { noAction: eligibility === "declared_widely" ? "declared_widely" : "eligibility_unknown" });
      continue;
    }
    page("page.takedown_overdue", key, {}, [{ method: "quarantine_version", pack: report.pack, version: report.version, reason: "security report undecided for an hour" }], { actionKey: key });
  }
}

/** The burn of a tier counted without the candidates, so a burn that belongs to a rollout can be told from the incumbent's own. */
function burn(ctx: DetectContext, page: PageSink, ticket: TicketSink): void {
  const all: BurnCounts = sumCounts(ctx.burn.map((r) => r.counts));
  const fired = firedTiers(all, ctx.requestsPerSecond);
  if (fired.length === 0) return;
  const incumbent = firedTiers(sumCounts(ctx.burn.filter((r) => !ctx.candidates.has(r.version_id)).map((r) => r.counts)), ctx.requestsPerSecond);
  const rolling = ctx.release !== null && ["building", "verifying", "rolling"].includes(ctx.release.state);
  for (const t of fired) {
    if (t.action === "ticket") {
      ticket("registry", `burn|${t.tier}`, { tier: t.tier });
      continue;
    }
    const incumbentBurning = incumbent.some((i) => i.tier === t.tier);
    const release: ReleaseContext = {
      rolloutInProgress: rolling,
      candidateOnly: rolling && !incumbentBurning,
      incumbentBurning,
      candidateAtFull: ctx.release?.state === "live",
      rollbackFailed: ctx.release?.state === "rollback_failed",
      burningForMs: ctx.burningSince === null ? 0 : ctx.now - ctx.burningSince,
    };
    page("page.read_path_burn", `burn|${t.tier}`, { tier: t.tier }, [], { release });
  }
}

function rate(ctx: DetectContext, signal: string): RateRow | undefined {
  return ctx.rates.find((r) => r.signal === signal);
}

function tickets(ctx: DetectContext, ticket: TicketSink): void {
  const published = rate(ctx, "publish.received");
  if (published) {
    const baselinePerHour = Math.max(1, (published.week - published.hour) / (7 * 24 - 1));
    if (published.hour >= FLOOD_FLOOR && published.hour >= FLOOD_FACTOR * baselinePerHour) {
      ticket("abuse_flood", "abuse_flood", { count: published.hour }, [{ method: "enable_new_pack_kill_switch", reason: "publish rate over 20 times the weekly baseline" }], "abuse_flood");
    }
  }
  const count = (signal: string, span: "n1h" | "n24h"): number => by(ctx.rows, signal).reduce((s, r) => s + r[span], 0);
  if (count("email.failed", "n1h") >= 3) ticket("email_failed", "email_failed", { count: count("email.failed", "n1h") });
  if (count("publish.oidc_rejected", "n1h") >= 10) ticket("oidc_blocked", "oidc_blocked", { count: count("publish.oidc_rejected", "n1h") });
  if (count("github.webhook_rejected", "n1h") >= 10) ticket("webhooks_failing", "webhooks_failing", { count: count("github.webhook_rejected", "n1h") });
  if (count("abuse.daily_cap_hit", "n24h") >= 5) ticket("daily_caps_pressure", "daily_caps_pressure", { count: count("abuse.daily_cap_hit", "n24h") });
  const backlog = by(ctx.rows, "queue.backlog").filter((r) => ctx.now - r.ts < 15 * 60_000);
  const audit = backlog.find((r) => (str(r.a.queue) ?? "").startsWith("audit") && r.d2 >= AUDIT_BACKLOG_S);
  if (audit) ticket("audit_backlog", "audit_backlog", {});
  if (backlog.some((r) => !(str(r.a.queue) ?? "").startsWith("audit") && r.d2 >= QUEUE_BACKLOG_S)) ticket("component", "queue_backlog", {});
}


/** Pages in the catalogue that nothing can raise yet, because no signal or audit input for them exists. */
export const PAGES_WITHOUT_INPUT: readonly PageId[] = ["page.admin_new_location"];
