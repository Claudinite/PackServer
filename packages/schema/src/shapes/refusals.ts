import { z } from "zod";

/** The reason words a refusal can carry, as values. Append-only. */
export const REFUSAL_REASONS = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "csrf_failed",
  "idempotency_key_missing",
  "idempotency_conflict",
  "rate_limited",
  "quota_exceeded",
  "turnstile_failed",
  "step_up_required",
  "under_review",
  "held",
  "kill_switch",
  "oidc.rejected",
  "archive.bomb",
  "archive.unsafe",
  "sandbox.timeout",
  "provenance.tree_mismatch",
  "engine.unsupported_min_version",
  "index.rollback",
  "index.stale",
  "release.unsupported",
  "schema.unsupported",
] as const;

export const RefusalReason = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReason>;

export const Refusal = z.object({
  reason: RefusalReason,
  message: z.string().optional(),
  retry_after_s: z.number().int().positive().optional(),
});
export type Refusal = z.infer<typeof Refusal>;
