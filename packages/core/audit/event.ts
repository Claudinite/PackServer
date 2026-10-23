import { z } from "zod";
import { acceptQueueMessage, queueMessage } from "@packserver/schema";

/** Message schema of the audit queue; the consumer accepts n and n+1. */
export const AUDIT_SCHEMA = 1;

/** Sensitive actions (REQ-AUDIT-001) and refusals (REQ-AUDIT-007). A new area adds its action here. */
export const AUDIT_ACTIONS = [
  "login",
  "factor.added",
  "factor.removed",
  "provider.linked",
  "token.minted",
  "token.revoked",
  "grant.changed",
  "trusted_publisher.changed",
  "publish.approved",
  "visibility.changed",
  "version.yanked",
  "admin.action",
  "signin.refused",
  "assertion.refused",
  "token.refused",
  "oidc.refused",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AuditActorSchema = z.object({
  kind: z.enum(["user", "admin", "token", "system", "anonymous"]),
  id: z.string().min(1).optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

const Detail = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const AuditEventSchema = queueMessage({
  /** Unique per event; the chain, the D1 copy and the verifier all reconcile on it. */
  id: z.string().min(1),
  /** ISO-8601 UTC. */
  at: z.iso.datetime(),
  actor: AuditActorSchema,
  action: z.enum(AUDIT_ACTIONS),
  target: z.string().min(1).optional(),
  /** Whose security history lists the event. */
  user_id: z.string().min(1).optional(),
  /** The scope or org whose audit history lists the event. */
  scope_id: z.string().min(1).optional(),
  /** Daily-rotating hash of the source address; the address itself never enters an event. */
  ip_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  detail: Detail.optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const acceptAuditEvent = (raw: unknown) => acceptQueueMessage(AUDIT_SCHEMA, AuditEventSchema, raw);
