import { createAudit } from "@packserver/core/audit";
import type { McpRuntime } from "../bindings";

/** A grant approved, ended, or refused for reuse is a token minted, revoked or refused (REQ-AUDIT-001, REQ-AUDIT-007). */
export type GrantEvent =
  | { action: "token.minted"; clientId: string; scope: string[] }
  | { action: "token.revoked"; clientId: string; reason: "owner" | "refresh_reused" }
  | { action: "token.refused"; reason: "refresh_reused" };

/** A failed send rejects, so a grant is never approved or ended without its record. */
export async function recordGrantEvent(runtime: McpRuntime, userId: string, grantId: string, event: GrantEvent): Promise<void> {
  const queue = runtime.ports.queues.AUDIT_QUEUE;
  if (!queue) throw new Error("the audit queue is not bound");
  const audit = createAudit({ clock: runtime.ports.clock, rng: runtime.ports.rng, queue, d1: runtime.ports.d1 }, { ipKey: "" });
  const detail: Record<string, string> =
    event.action === "token.minted" ? { name: event.clientId, scopes: event.scope.join(" ") }
    : event.action === "token.revoked" ? { name: event.clientId, reason: event.reason }
    : { reason: event.reason };
  await audit({ kind: "user", id: userId }, event.action, `oauth:${grantId}`, { user_id: userId, detail });
}
