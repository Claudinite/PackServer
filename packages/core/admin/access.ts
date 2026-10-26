import type { AccessIdentity, AccessIdentityClaims } from "@packserver/ports";
import { PortError } from "@packserver/ports";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** What the admin Worker admits: one Access application, a short list of people, and the hostnames that application protects. */
export interface AccessPolicy {
  audience: string;
  /** Lower-cased email addresses. */
  identities: readonly string[];
  /** Lower-cased hostnames without a port. */
  hosts: readonly string[];
}

export type AccessRefusal = "unconfigured" | "host" | "audience" | "expired" | "identity" | "claims";

export type AccessDecision = { ok: true; email: string; sub: string } | { ok: false; reason: AccessRefusal };

export const splitList = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);

/** A value still holding the repository's placeholder is no configuration: the Worker then admits no one. */
export const isPlaceholder = (value: string | undefined): boolean => !value || /^(?:TODO|CHANGE_ME|PLACEHOLDER)|^[A-Z][A-Z0-9_]*$/.test(value.trim());

export function policyFrom(vars: { ACCESS_AUDIENCE?: string; ADMIN_IDENTITIES?: string; ADMIN_HOSTS?: string }): AccessPolicy | null {
  const identities = splitList(vars.ADMIN_IDENTITIES);
  const hosts = splitList(vars.ADMIN_HOSTS);
  const audience = vars.ACCESS_AUDIENCE?.trim();
  if (!audience || isPlaceholder(audience) || isPlaceholder(vars.ADMIN_IDENTITIES) || identities.length === 0 || hosts.length === 0) return null;
  return { audience, identities, hosts };
}

const hostOf = (host: string): string => host.toLowerCase().replace(/:\d+$/, "");

/** True only for a request addressed to a hostname the Access application protects; a `workers.dev` or preview name is not one. */
export function onProtectedHost(host: string | undefined, policy: AccessPolicy): boolean {
  return host !== undefined && policy.hosts.includes(hostOf(host));
}

/** The checks the signature does not cover: the audience, the expiry and membership of the allowed set. */
export function checkClaims(claims: AccessIdentityClaims, policy: AccessPolicy, nowMs: number): AccessDecision {
  if (!claims.aud || !claims.aud.includes(policy.audience)) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  const email = claims.email.toLowerCase();
  if (!email || !claims.sub) return { ok: false, reason: "claims" };
  if (!policy.identities.includes(email)) return { ok: false, reason: "identity" };
  return { ok: true, email, sub: claims.sub };
}

/** Verifies a request's assertion end to end; every refusal is one the caller answers as an unknown path. */
export async function admitRequest(
  request: { host: string | undefined; assertion: string | undefined },
  deps: { policy: AccessPolicy | null; access: AccessIdentity; nowMs: number },
): Promise<AccessDecision> {
  if (!deps.policy) return { ok: false, reason: "unconfigured" };
  if (!onProtectedHost(request.host, deps.policy)) return { ok: false, reason: "host" };
  if (!request.assertion) return { ok: false, reason: "claims" };
  let claims: AccessIdentityClaims;
  try {
    claims = await deps.access.verify(request.assertion);
  } catch {
    return { ok: false, reason: "claims" };
  }
  return checkClaims(claims, deps.policy, deps.nowMs);
}

export interface JwtAccessOptions {
  /** `<team>.cloudflareaccess.com`. */
  teamDomain: string;
  audience: string;
  /** Replaces the key set, for a test that signs with its own key. */
  keys?: JWTVerifyGetKey;
  now?: () => number;
}

/** Cloudflare Access's own assertion: an RS256 JWT signed by the team's published keys, issued for this application. */
export function jwtAccessIdentity(options: JwtAccessOptions): AccessIdentity {
  const issuer = `https://${options.teamDomain}`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return {
    async verify(assertion) {
      try {
        const { payload } = await jwtVerify(assertion, keys, {
          issuer,
          audience: options.audience,
          algorithms: ["RS256"],
          ...(options.now ? { currentDate: new Date(options.now()) } : {}),
        });
        const email = typeof payload.email === "string" ? payload.email : typeof payload.common_name === "string" ? payload.common_name : "";
        const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
        return { email, sub: String(payload.sub ?? ""), aud, ...(payload.exp === undefined ? {} : { exp: payload.exp }) };
      } catch (error) {
        throw new PortError("bad_assertion", `the Access assertion did not verify: ${error instanceof Error ? error.message : "unknown"}`);
      }
    },
  };
}
