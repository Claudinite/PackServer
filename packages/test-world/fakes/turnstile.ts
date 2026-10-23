import { FakeTurnstile } from "@packserver/ports/fakes";
import type { NetHandler } from "./net";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's siteverify endpoint, answering from the ports fake: only the always-pass token succeeds. */
export function turnstileHandler(turnstile: FakeTurnstile): NetHandler {
  return async (request) => {
    if (request.method !== "POST" || request.url !== TURNSTILE_VERIFY_URL) return undefined;
    const form = await request.formData();
    const result = await turnstile.verify(String(form.get("response") ?? ""));
    return Response.json({ success: result.success, "error-codes": result.codes });
  };
}
