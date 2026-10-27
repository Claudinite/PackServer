import { auditCursor, GATES_KV_KEYS, judgeAuditEvent, parseAuditEvents, type AuditEvent, type ReleaseRecord } from "@packserver/core/gates";
import type { Telemetry } from "@packserver/core/telemetry";
import type { Clock, KV } from "@packserver/ports";

export interface AuditPageRequest {
  since: string;
  before: string;
  cursor: string | null;
}

/** Reads the account's audit log, oldest first; the token behind it can read and nothing else. */
export interface AuditLog {
  list(request: AuditPageRequest): Promise<unknown>;
}

export const AUDIT_PAGE_SIZE = 100;

export function cloudflareAuditLog(config: { accountId: () => Promise<string>; token: () => Promise<string> }, fetchImpl: typeof fetch = fetch): AuditLog {
  return {
    async list({ since, before, cursor }) {
      const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${await config.accountId()}/logs/audit`);
      url.searchParams.set("since", since);
      url.searchParams.set("before", before);
      url.searchParams.set("direction", "asc");
      url.searchParams.set("limit", String(AUDIT_PAGE_SIZE));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${await config.token()}` } });
      if (!response.ok) throw new Error(`the audit log answered ${response.status}`);
      return response.json();
    },
  };
}

interface State {
  since: string;
  /** Ids of the entries already handled at exactly `since`, since a boundary may be read twice. */
  seen: string[];
}

export const FIRST_LOOKBACK_MS = 10 * 60_000;
/** Pages read in one invocation; what lies beyond is read next time, the listing being oldest first. */
export const MAX_AUDIT_PAGES = 10;

export interface AuditPoll {
  read: number;
  signalled: number;
  pageworthy: number;
  /** Page-list events left for the next invocation by the point budget or the page limit. */
  deferred: boolean;
  /** The events no release accounts for; `signingKey` marks one that binds a signing secret to a Worker other than the validator. */
  events: Array<{ id: string; signingKey: boolean }>;
}

const scriptOf = (uri: string): string | null => /\/workers\/scripts\/([^/?]+)/.exec(uri)?.[1] ?? null;

/** A binding of a signing secret to a Worker that is not the validator, which alone may hold one. */
export function bindsSigningKey(event: AuditEvent): boolean {
  if (!/signing[_-]?key/i.test(`${event.uri} ${event.resource.id ?? ""} ${event.resource.type}`)) return false;
  const script = scriptOf(event.uri) ?? event.resource.id ?? "";
  return !/^validator(-staging)?$/.test(script);
}

/** Emits `cloudflare.audit_event` for each new event on the page list, with whether the release in flight accounts for it. */
export async function pollAccountAudit(options: {
  log: AuditLog;
  kv: KV;
  clock: Clock;
  emit: Telemetry["emit"];
  release: ReleaseRecord | null;
  ciTokenIds: readonly string[];
  maxSignals: number;
}): Promise<AuditPoll> {
  const now = options.clock.now();
  const raw = await options.kv.get(GATES_KV_KEYS.auditCursor);
  const state: State = raw ? (JSON.parse(raw) as State) : { since: new Date(now - FIRST_LOOKBACK_MS).toISOString(), seen: [] };
  const handled = new Set(state.seen);
  const before = new Date(now).toISOString();
  const poll: AuditPoll = { read: 0, signalled: 0, pageworthy: 0, deferred: false, events: [] };
  let since = state.since;
  let seen = state.seen;

  let cursor: string | null = null;
  for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
    const body = await options.log.list({ since: state.since, before, cursor });
    const events: AuditEvent[] = parseAuditEvents(body).sort((a, b) => a.at.localeCompare(b.at));
    poll.read += events.length;
    for (const event of events) {
      if (event.at < since || handled.has(event.id) || (event.at === since && seen.includes(event.id))) continue;
      const judgement = judgeAuditEvent(event, { ciTokenIds: options.ciTokenIds, release: options.release });
      if (judgement && poll.signalled >= options.maxSignals) {
        poll.deferred = true;
        break;
      }
      if (judgement) {
        options.emit("cloudflare.audit_event", {
          entry: event.id,
          action: event.actionType,
          category: judgement.category,
          actor_kind: judgement.actor,
          actor_id: event.actor.tokenId ?? event.actor.id ?? "",
          ci_token: judgement.ciToken,
          accounted_for: judgement.accountedFor,
          pageworthy: judgement.pageworthy,
          at: event.at,
          resource: `${event.resource.product}/${event.resource.type}/${event.resource.id ?? ""}`.slice(0, 200),
        });
        poll.signalled++;
        if (judgement.pageworthy) {
          poll.pageworthy++;
          poll.events.push({ id: event.id, signingKey: bindsSigningKey(event) });
        }
      }
      seen = event.at === since ? [...seen, event.id] : [event.id];
      since = event.at;
    }
    if (poll.deferred) break;
    cursor = auditCursor(body);
    if (!cursor || events.length === 0) break;
    if (page === MAX_AUDIT_PAGES - 1) poll.deferred = true;
  }
  await options.kv.put(GATES_KV_KEYS.auditCursor, JSON.stringify({ since, seen } satisfies State));
  return poll;
}
