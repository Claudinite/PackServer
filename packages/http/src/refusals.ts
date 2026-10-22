import { Refusal, type RefusalReason } from "@packserver/schema";

/** One status per register word; the exhaustive record makes a new reason a compile error here. */
export const REFUSAL_STATUS: Readonly<Record<RefusalReason, number>> = {
  "step-up": 403,
  "mfa-required": 403,
  "oidc.fork": 401,
  "oidc.workflow": 401,
  "oidc.environment": 401,
  "oidc.invalid": 401,
  signature: 401,
  "signed-out": 401,
  "rate-limited": 429,
  "human-check": 403,
  forbidden: 403,
  exists: 409,
  "trusted-only": 403,
  quota: 403,
  "unknown-tool": 400,
  scope: 403,
  "archive.bomb": 422,
  "archive.unsafe": 422,
  "index.rollback": 409,
  "index.stale": 409,
};

export interface RefusalOptions {
  message?: string;
  retry_after_s?: number;
  /** Overrides the reason's default status, for a refusal that is really a malformed request. */
  status?: number;
}

/** Builds the refusal response: a JSON `Refusal` body, `Retry-After` when given, never cached. */
export function refusal(reason: RefusalReason, options: RefusalOptions = {}): Response {
  const body = Refusal.parse({
    reason,
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.retry_after_s === undefined ? {} : { retry_after_s: options.retry_after_s }),
  });
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (body.retry_after_s !== undefined) headers.set("retry-after", String(body.retry_after_s));
  return new Response(JSON.stringify(body), { status: options.status ?? REFUSAL_STATUS[reason], headers });
}
