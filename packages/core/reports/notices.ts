import { sendNotice, type NoticeData, type NoticeKind } from "../mail/index.ts";
import type { Mail } from "@packserver/ports";
import type { D1 } from "@packserver/ports";
import { isoNow, type ReportPorts } from "./ports.ts";

export const REGISTRY_SECURITY = "registry-security";

export type ReportNotice = {
  [K in Extract<NoticeKind, "report-status-changed" | "security-report-reminder" | "security-report-update">]: { kind: K; data: NoticeData<K> };
}[Extract<NoticeKind, "report-status-changed" | "security-report-reminder" | "security-report-update">];

/** Where a notice goes: a person, an address a pack's owners gave, or registry security. */
export type Recipient = `user:${string}` | `address:${string}` | typeof REGISTRY_SECURITY;

/** The statement that queues one notice; it goes in the same batch as the change that causes it. */
export function noticeStatement(ports: ReportPorts, to: Recipient, notice: ReportNotice): { sql: string; params: unknown[] } {
  return {
    sql: "insert into report_notices (id, kind, recipient, data, created_at, sent_at) values (?, ?, ?, ?, ?, null)",
    params: [ports.rng.uuid(), notice.kind, to, JSON.stringify(notice.data), isoNow(ports)],
  };
}

export const MAX_NOTICE_ATTEMPTS = 5;

export interface NoticeDelivery {
  mail: Mail;
  /** Queued notices carry the path of their report; this makes it a link. */
  siteOrigin: string;
  /** Where registry security's notices go. */
  securityAddress: string;
  /** Asked before each send with the queries the send and its mark need; a run that was told no stops there, its notices untouched. */
  hasRoom?: (queries: number) => boolean;
}

async function addressOf(d1: D1, to: string, securityAddress: string): Promise<string | null> {
  if (to === REGISTRY_SECURITY) return securityAddress;
  if (to.startsWith("address:")) return to.slice("address:".length);
  const { rows } = await d1.query("select address from user_emails where user_id = ? order by created_at limit 1", [to.slice("user:".length)]);
  return rows[0] ? String(rows[0].address) : null;
}

/**
 * Sends what is queued, oldest first, and marks each sent only once the mail port accepted it, so a failure
 * leaves the notice to be tried again. A person with no verified address is skipped and marked, not retried forever.
 */
export async function drainNotices(ports: ReportPorts, delivery: NoticeDelivery, limit = 50): Promise<{ sent: number; skipped: number; failed: number }> {
  const { rows } = await ports.d1.query("select id, kind, recipient, data from report_notices where sent_at is null and attempts < ? order by rowid limit ?", [MAX_NOTICE_ATTEMPTS, limit]);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (delivery.hasRoom && !delivery.hasRoom(3)) break;
    try {
      const address = await addressOf(ports.d1, String(row.recipient), delivery.securityAddress);
      if (address !== null) {
        const kind = String(row.kind) as ReportNotice["kind"];
        const data = JSON.parse(String(row.data)) as { reportUrl: string };
        await sendNotice(delivery.mail, address, kind, { ...data, reportUrl: `${delivery.siteOrigin}${data.reportUrl}` } as never);
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({ event: "cron.report-notices.send_failed", notice_id: String(row.id), kind: String(row.kind), reason: String(error) }));
      await ports.d1.query("update report_notices set attempts = attempts + 1 where id = ?", [row.id]);
      continue;
    }
    // Outside the send's catch: a failed mark is not a failed send.
    await ports.d1.query("update report_notices set sent_at = ? where id = ?", [isoNow(ports), row.id]);
  }
  return { sent, skipped, failed };
}

