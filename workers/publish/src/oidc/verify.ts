import { ActionsClaims } from "@packserver/core/publishing";
import { decodeJwt, decodeProtectedHeader, errors, importJWK, jwtVerify } from "jose";
import type { Clock } from "@packserver/ports";
import { findKey, type JwksDeps } from "./jwks";

export const SUPPORTED_ALGORITHM = "RS256";
const CLOCK_TOLERANCE_S = 10;
/** GitHub tokens live minutes; an older one is a leaked or replayed token, and one issued in the future is forged. */
const MAX_TOKEN_AGE = "10m";

export type RejectedBecause = "malformed" | "algorithm" | "issuer" | "audience" | "key" | "signature" | "expired" | "not-yet-valid" | "claims";

export interface VerifyDeps extends JwksDeps {
  clock: Clock;
  issuer: string;
  audience: string;
}

export type Verified = { ok: true; claims: ActionsClaims } | { ok: false; because: RejectedBecause };

/**
 * Every check that needs no key runs first, so a token of the wrong issuer, audience or
 * algorithm never costs a fetch of the key set. Throws `JwksUnavailable` when the keys are needed and cannot be had.
 */
export async function verifyActionsToken(token: string, deps: VerifyDeps): Promise<Verified> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(token);
    payload = decodeJwt(token);
  } catch {
    return { ok: false, because: "malformed" };
  }
  if (header.alg !== SUPPORTED_ALGORITHM) return { ok: false, because: "algorithm" };
  if (payload.iss !== deps.issuer) return { ok: false, because: "issuer" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(deps.audience)) return { ok: false, because: "audience" };
  if (typeof header.kid !== "string" || header.kid === "") return { ok: false, because: "key" };

  const { jwk } = await findKey(deps, header.kid);
  if (!jwk) return { ok: false, because: "key" };

  try {
    const key = await importJWK(jwk, SUPPORTED_ALGORITHM);
    const { payload: verified } = await jwtVerify(token, key, {
      issuer: deps.issuer,
      audience: deps.audience,
      algorithms: [SUPPORTED_ALGORITHM],
      requiredClaims: ["exp", "iat"],
      currentDate: new Date(deps.clock.now()),
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: MAX_TOKEN_AGE,
    });
    const claims = ActionsClaims.safeParse(verified);
    return claims.success ? { ok: true, claims: claims.data } : { ok: false, because: "claims" };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, because: "expired" };
    if (error instanceof errors.JWTClaimValidationFailed) return { ok: false, because: error.claim === "nbf" ? "not-yet-valid" : error.claim === "aud" ? "audience" : error.claim === "iss" ? "issuer" : "claims" };
    return { ok: false, because: "signature" };
  }
}
