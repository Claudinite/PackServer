export type ActorKind = "user" | "token" | "system" | "unknown";

export interface AuditEvent {
  at: string;
  action: string;
  actor: { kind: ActorKind; id: string | null; email: string | null };
  resources: Array<{ type: string; id: string }>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Reads the `result` of an audit-log listing; an entry without a time or an action is dropped. */
export function parseAuditEvents(body: unknown): AuditEvent[] {
  const result = obj(body)?.result;
  if (!Array.isArray(result)) return [];
  const events: AuditEvent[] = [];
  for (const raw of result) {
    const e = obj(raw);
    if (!e) continue;
    const action = str(e.action) ?? str(obj(e.action)?.type);
    const at = str(e.timestamp) ?? str(e.when);
    if (!action || !at) continue;
    const actor = obj(e.actor);
    const type = str(actor?.type)?.toLowerCase() ?? "";
    const kind: ActorKind = type.includes("token") || str(actor?.token_id) !== null ? "token" : type === "system" ? "system" : actor ? "user" : "unknown";
    const resources = (Array.isArray(e.resources) ? e.resources : [e.resource]).flatMap((r) => {
      const x = obj(r);
      const id = str(x?.resource_id) ?? str(x?.id);
      return x && id ? [{ type: str(x.resource_type) ?? str(x.type) ?? "", id }] : [];
    });
    events.push({ at, action, actor: { kind, id: str(actor?.token_id) ?? str(actor?.id), email: str(actor?.email) }, resources });
  }
  return events;
}

/** The categories REQ-OPS-013 and monitoring.md put on the page list, matched on the action name. */
export const PAGE_LIST = [
  ["worker_upload", /worker.*(script|upload|version|deploy)|script.*(upload|update|create)/],
  ["worker_route", /route/],
  ["token", /token/],
  ["member", /member|invite/],
  ["access", /access|zero_?trust/],
  ["logpush", /logpush|logs?\.job/],
  ["bucket_lock", /(bucket|r2).*lock|lock.*(bucket|r2)/],
  ["observability", /observability|telemetry|traces/],
  ["secrets", /secret/],
  ["waf", /waf|firewall|ruleset|rate_?limit/],
] as const;
export type PageCategory = (typeof PAGE_LIST)[number][0];

/** Releases account for their own uploads and routes, and for nothing else. */
const RELEASE_CATEGORIES: readonly PageCategory[] = ["worker_upload", "worker_route", "observability"];

const READ_ONLY = /(^|[._])(view|list|read|get)([._]|$)/;

export function pageCategory(action: string): PageCategory | null {
  const a = action.toLowerCase();
  if (READ_ONLY.test(a)) return null;
  return PAGE_LIST.find(([, pattern]) => pattern.test(a))?.[0] ?? null;
}

/** The candidate record the release tooling mirrors: no digests, only which Workers moved to which version. */
export interface ReleaseRecord {
  release_id: string;
  state: string;
  workers: Record<string, { version_id?: string; changed?: boolean } | undefined>;
}

export interface AuditJudgement {
  category: PageCategory;
  actor: ActorKind;
  ciToken: boolean;
  accountedFor: boolean;
  /** Whether `page.account_change` should fire on this event. */
  pageworthy: boolean;
}

export interface AuditContext {
  ciTokenIds: readonly string[];
  release: ReleaseRecord | null;
}

const IN_FLIGHT = new Set(["building", "verifying", "rolling", "live", "finalised"]);

function touchesChangedWorker(event: AuditEvent, release: ReleaseRecord): boolean {
  const names = Object.entries(release.workers).flatMap(([name, w]) => (w?.changed === true ? [name, `${name}-staging`] : []));
  return event.resources.some((r) => names.includes(r.id));
}

/** Null for an event off the page list; otherwise whether the release the judge knows of accounts for it. */
export function judgeAuditEvent(event: AuditEvent, context: AuditContext): AuditJudgement | null {
  const category = pageCategory(event.action);
  if (!category) return null;
  const ciToken = event.actor.kind === "token" && event.actor.id !== null && context.ciTokenIds.includes(event.actor.id);
  const accountedFor =
    ciToken && context.release !== null && IN_FLIGHT.has(context.release.state) && RELEASE_CATEGORIES.includes(category) && touchesChangedWorker(event, context.release);
  return { category, actor: event.actor.kind, ciToken, accountedFor, pageworthy: !accountedFor };
}

/** A stable identity for an event, since the listing gives none. */
export const auditFingerprint = (e: AuditEvent): string => [e.at, e.action, e.actor.id ?? "", e.resources.map((r) => r.id).join(",")].join("|");
