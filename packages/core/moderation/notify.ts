import { sendNotice, type NoticeData, type NoticeKind } from "../mail/index.ts";
import { ownerAddresses } from "../scopes/proofs/context.ts";
import type { ModerationPorts } from "./ports.ts";

/** A notice that cannot be sent is logged and does not undo the decision it reports. */
export async function notifyOwners<K extends NoticeKind>(ports: Pick<ModerationPorts, "d1" | "mail">, scopeId: string, kind: K, data: NoticeData<K>): Promise<void> {
  const results = await Promise.allSettled((await ownerAddresses(ports.d1, scopeId)).map((to) => sendNotice(ports.mail, to, kind, data)));
  for (const r of results) if (r.status === "rejected") console.log(JSON.stringify({ event: "moderation.notice_failed", kind, reason: String(r.reason) }));
}

export async function notifyUser<K extends NoticeKind>(ports: Pick<ModerationPorts, "d1" | "mail">, userId: string, kind: K, data: NoticeData<K>): Promise<void> {
  const { rows } = await ports.d1.query("select address from user_emails where user_id = ? order by created_at limit 1", [userId]);
  if (!rows[0]) return;
  try {
    await sendNotice(ports.mail, String(rows[0].address), kind, data);
  } catch (error) {
    console.log(JSON.stringify({ event: "moderation.notice_failed", kind, reason: String(error) }));
  }
}
