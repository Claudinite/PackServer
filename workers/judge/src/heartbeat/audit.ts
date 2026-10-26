import { auditFingerprint, GATES_KV_KEYS, judgeAuditEvent, parseAuditEvents, type ReleaseRecord } from "@packserver/core/gates";
import type { Telemetry } from "@packserver/core/telemetry";
import type { Clock, KV } from "@packserver/ports";

/** Reads the account's audit log; the token behind it can read and nothing else. */
export interface AuditLog {
  list(sinceIso: string, beforeIso: string): Promise<unknown>;
}

export function cloudflareAuditLog(config: { accountId: () => Promise<string>; token: () => Promise<string> }, fetchImpl: typeof fetch = fetch): AuditLog {
  return {
    async list(since, before) {
      const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${await config.accountId()}/logs/audit`);
      url.searchParams.set("since", since);
      url.searchParams.set("before", before);
      url.searchParams.set("limit", "100");
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${await config.token()}` } });
      if (!response.ok) throw new Error(`the audit log answered ${response.status}`);
      return response.json();
    },
  };
}

interface Cursor {
  since: string;
  /** Fingerprints of the events already handled at exactly `since`, since the listing gives no id and a boundary may be read twice. */
  seen: string[];
}

export const FIRST_LOOKBACK_MS = 10 * 60_000;
/** What one invocation leaves room for among its 25 Analytics Engine points. */
export const MAX_AUDIT_SIGNALS = 5;

export interface AuditPoll {
  read: number;
  signalled: number;
  pageworthy: number;
  /** Events past the invocation's point budget, left for the next one. */
  deferred: number;
}

/** Emits `cloudflare.audit_event` for each new event on the page list, with whether the release in flight accounts for it. */
export async function pollAccountAudit(options: {
  log: AuditLog;
  kv: KV;
  clock: Clock;
  emit: Telemetry["emit"];
  release: ReleaseRecord | null;
  ciTokenIds: readonly string[];
}): Promise<AuditPoll> {
  const now = options.clock.now();
  const raw = await options.kv.get(GATES_KV_KEYS.auditCursor);
  const cursor: Cursor = raw ? (JSON.parse(raw) as Cursor) : { since: new Date(now - FIRST_LOOKBACK_MS).toISOString(), seen: [] };
  const events = parseAuditEvents(await options.log.list(cursor.since, new Date(now).toISOString()))
    .filter((e) => e.at >= cursor.since)
    .sort((a, b) => a.at.localeCompare(b.at));
  const handled = new Set(cursor.seen);
  const poll: AuditPoll = { read: events.length, signalled: 0, pageworthy: 0, deferred: 0 };
  let since = cursor.since;
  let seen = cursor.seen;
  for (const event of events) {
    const fingerprint = auditFingerprint(event);
    if (handled.has(fingerprint)) continue;
    const judgement = judgeAuditEvent(event, { ciTokenIds: options.ciTokenIds, release: options.release });
    if (judgement && poll.signalled >= MAX_AUDIT_SIGNALS) {
      poll.deferred++;
      break;
    }
    if (judgement) {
      options.emit("cloudflare.audit_event", {
        action: event.action,
        category: judgement.category,
        actor_kind: judgement.actor,
        actor_id: event.actor.id ?? "",
        ci_token: judgement.ciToken,
        accounted_for: judgement.accountedFor,
        pageworthy: judgement.pageworthy,
        at: event.at,
        resources: event.resources.map((r) => r.id).join(",").slice(0, 200),
      });
      poll.signalled++;
      if (judgement.pageworthy) poll.pageworthy++;
    }
    seen = event.at === since ? [...seen, fingerprint] : [fingerprint];
    since = event.at;
  }
  await options.kv.put(GATES_KV_KEYS.auditCursor, JSON.stringify({ since, seen } satisfies Cursor));
  return poll;
}
