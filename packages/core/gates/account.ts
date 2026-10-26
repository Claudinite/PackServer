export type ActorKind = "user" | "token" | "system" | "unknown";

/** One entry of `GET /accounts/{id}/logs/audit` (audit logs v2), reduced to what the page list needs. */
export interface AuditEvent {
  id: string;
  at: string;
  /** `create`, `update`, `delete`, `view`... */
  actionType: string;
  actor: { kind: ActorKind; tokenId: string | null; id: string | null; email: string | null };
  resource: { id: string | null; product: string; type: string };
  /** The request path, which names the Worker script or the product an action touched. */
  uri: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Reads the `result` of an audit-log listing; an entry without an id, a time or an action type is dropped. */
export function parseAuditEvents(body: unknown): AuditEvent[] {
  const result = obj(body)?.result;
  if (!Array.isArray(result)) return [];
  const events: AuditEvent[] = [];
  for (const raw of result) {
    const e = obj(raw);
    const action = obj(e?.action);
    const id = str(e?.id);
    const at = str(action?.time);
    const actionType = str(action?.type);
    if (!e || !id || !at || !actionType) continue;
    const actor = obj(e.actor);
    const tokenId = str(actor?.token_id);
    const type = str(actor?.type);
    const resource = obj(e.resource);
    events.push({
      id,
      at,
      actionType: actionType.toLowerCase(),
      actor: { kind: tokenId !== null || str(actor?.context) === "api_token" ? "token" : type === "system" ? "system" : actor ? "user" : "unknown", tokenId, id: str(actor?.id), email: str(actor?.email) },
      resource: { id: str(resource?.id), product: str(resource?.product) ?? "", type: str(resource?.type) ?? "" },
      uri: str(obj(e.raw)?.uri) ?? "",
    });
  }
  return events;
}

/** The cursor to the next page of a listing, absent on the last. */
export const auditCursor = (body: unknown): string | null => str(obj(obj(body)?.result_info)?.cursor);

/**
 * The categories REQ-OPS-013 and monitoring.md put on the page list. An entry carries no action name,
 * only a type like `update`, so a category is read off the product, the resource type and the request path.
 */
export const PAGE_LIST = [
  ["secrets", /secrets?\b/],
  ["observability", /observability|telemetry|traces/],
  ["worker_route", /workers\/routes|worker.?route/],
  ["worker_upload", /workers\/(scripts|services)|worker.?script/],
  ["token", /tokens?\b/],
  ["member", /members?\b|invites?\b/],
  ["access", /access|zero.?trust/],
  ["logpush", /logpush|logs\/(control|jobs)/],
  ["bucket_lock", /(r2|bucket).*lock|lock.*(r2|bucket)/],
  ["waf", /waf|firewall|rulesets?\b|rate.?limit/],
] as const;
export type PageCategory = (typeof PAGE_LIST)[number][0];

const READ_ONLY = new Set(["view", "read", "get", "list"]);

export function pageCategory(event: Pick<AuditEvent, "actionType" | "resource" | "uri">): PageCategory | null {
  if (READ_ONLY.has(event.actionType)) return null;
  const haystack = `${event.resource.product} ${event.resource.type} ${event.uri}`.toLowerCase();
  return PAGE_LIST.find(([, pattern]) => pattern.test(haystack))?.[0] ?? null;
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

const IN_FLIGHT = new Set(["building", "verifying", "rolling"]);

/** The script name in `/workers/scripts/<name>/...`, which `wrangler` uploads to under the Worker's own name. */
const scriptOf = (uri: string): string | null => /\/workers\/scripts\/([^/?]+)/.exec(uri)?.[1] ?? null;

/**
 * An upload is the release's own when it targets a Worker the manifest changed and names that
 * Worker's manifest version; a rollout step on the same Worker's deployments is too, but only while
 * the release is rolling. Anything else a CI token does, in any state, is not accounted for.
 */
function matchesManifest(event: AuditEvent, category: PageCategory, release: ReleaseRecord): boolean {
  if (category !== "worker_upload" || !IN_FLIGHT.has(release.state)) return false;
  const script = scriptOf(event.uri) ?? event.resource.id;
  const worker = Object.entries(release.workers).find(([name, w]) => w?.changed === true && (script === name || script === `${name}-staging`));
  if (!worker) return false;
  const version = worker[1]?.version_id;
  if (version && (event.resource.id === version || event.uri.includes(version))) return true;
  return release.state === "rolling" && /\/deployments\b/.test(event.uri);
}

/** Null for an event off the page list; otherwise whether the release the judge knows of accounts for it. */
export function judgeAuditEvent(event: AuditEvent, context: AuditContext): AuditJudgement | null {
  const category = pageCategory(event);
  if (!category) return null;
  const ciToken = event.actor.kind === "token" && event.actor.tokenId !== null && context.ciTokenIds.includes(event.actor.tokenId);
  const accountedFor = ciToken && context.release !== null && matchesManifest(event, category, context.release);
  return { category, actor: event.actor.kind, ciToken, accountedFor, pageworthy: !accountedFor };
}
