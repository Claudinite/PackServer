import type { AdminRequest } from "@packserver/schema";
import { ADMIN_METHODS } from "@packserver/schema";
import type { AdminClient } from "../heartbeat/admin-client";

/** What REQ-ADMIN-010 lets the judge do on its own; anything else is refused here before it reaches the API. */
export const JUDGE_METHODS: ReadonlySet<string> = new Set(Object.entries(ADMIN_METHODS).filter(([, p]) => (p.callers as readonly string[]).includes("judge") && !p.requires_access_assertion).map(([m]) => m));

export type ActionOutcome = { ok: true; auditId: string } | { ok: false; reason: string };

/** Takes the automatic action through the admin internal API; the API still checks the method set itself. */
export async function runSafeAction(admin: AdminClient, request: AdminRequest): Promise<ActionOutcome> {
  if (!JUDGE_METHODS.has(request.method)) return { ok: false, reason: `${request.method} is not a method the judge may call` };
  try {
    const answer = await admin.call(request);
    return answer.ok ? { ok: true, auditId: answer.audit_id } : { ok: false, reason: answer.refusal.reason };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : "the admin API could not be reached" };
  }
}
