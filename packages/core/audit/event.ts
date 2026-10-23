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

/** The only detail fields each action may carry; a caller cannot put anything else, a secret included, in the record. */
export const DETAIL_FIELDS: Record<AuditAction, readonly string[]> = {
  login: ["method"],
  "factor.added": ["kind"],
  "factor.removed": ["kind"],
  "provider.linked": ["provider"],
  "token.minted": ["name", "scopes", "expires_at"],
  "token.revoked": ["name", "reason"],
  "grant.changed": ["role", "change"],
  "trusted_publisher.changed": ["change"],
  "publish.approved": ["version"],
  "visibility.changed": ["from", "to"],
  "version.yanked": ["version", "reason"],
  "admin.action": ["verb"],
  "signin.refused": ["reason"],
  "assertion.refused": ["reason"],
  "token.refused": ["reason"],
  "oidc.refused": ["reason"],
};

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
}).superRefine((event, ctx) => {
  const allowed = DETAIL_FIELDS[event.action];
  for (const key of Object.keys(event.detail ?? {})) {
    if (!allowed.includes(key)) ctx.addIssue({ code: "custom", path: ["detail", key], message: `${event.action} does not take detail.${key}` });
  }
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const acceptAuditEvent = (raw: unknown) => acceptQueueMessage(AUDIT_SCHEMA, AuditEventSchema, raw);
