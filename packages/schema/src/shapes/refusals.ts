import { z } from "zod";

/** The reason words a refusal can carry, as values: dsl.md section 3 plus the dotted register words. Append-only. */
export const REFUSAL_REASONS = [
  "step-up",
  "mfa-required",
  "oidc.fork",
  "oidc.workflow",
  "oidc.environment",
  "oidc.invalid",
  "signature",
  "signed-out",
  "rate-limited",
  "human-check",
  "forbidden",
  "exists",
  "trusted-only",
  "quota",
  "unknown-tool",
  "scope",
  "archive.bomb",
  "archive.unsafe",
  "index.rollback",
  "index.stale",
] as const;

export const RefusalReason = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReason>;

/** What kind of claim an OIDC token got wrong. Never the registered values, which would tell any GitHub user what a registration holds. */
export const CLAIM_CATEGORIES = ["fork", "workflow", "environment"] as const;
export const ClaimCategory = z.enum(CLAIM_CATEGORIES);
export type ClaimCategory = z.infer<typeof ClaimCategory>;
export const ClaimDiff = z.array(ClaimCategory);
export type ClaimDiff = z.infer<typeof ClaimDiff>;

export const Refusal = z.object({
  reason: RefusalReason,
  message: z.string().optional(),
  retry_after_s: z.number().int().positive().optional(),
  claim_diff: ClaimDiff.optional(),
});
export type Refusal = z.infer<typeof Refusal>;

/** Why a held version waits (dsl.md section 2.4). Append-only. */
export const HOLD_REASONS = [
  "new-capability",
  "review-requested",
  "prose-screen",
  "budget",
  "name-near-miss",
  "install-url",
] as const;
export const HoldReason = z.enum(HOLD_REASONS);
export type HoldReason = z.infer<typeof HoldReason>;
