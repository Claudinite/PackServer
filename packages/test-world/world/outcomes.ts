// How a World verb reports a business outcome. A verb never throws for these (that is
// `InfrastructureError`); it returns one of these values, and a matcher reads it.

export type RefusalReason =
  | "step-up" | "mfa-required" | "oidc.fork" | "oidc.workflow" | "oidc.environment" | "oidc.invalid" | "signature" | "signed-out"
  | "rate-limited" | "human-check" | "forbidden" | "exists" | "trusted-only" | "quota" | "unknown-tool" | "scope";

export class Refusal {
  constructor(
    readonly reason: RefusalReason,
    readonly detail: { claimDiff?: Record<string, { expected: unknown; actual: unknown }>; message?: string; retryAfterS?: number } = {},
  ) {}
}

/** The same shape for a nonexistent resource and for one the caller may not know exists. */
export class NotFound {}

/** A delivery that was acknowledged and changed nothing. */
export class Ignored {}

/** What a download for a quarantined version answers. */
export class Held {
  constructor(readonly reason?: string) {}
}

/** An observation of a response, as the World exposes it: no timing, only headers the World names. */
export interface Observation {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Email {
  subject: string;
  text: string;
  links: string[];
}
export interface InboxLike {
  all(): Email[];
}
