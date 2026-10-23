import type { Clock, KV } from "@packserver/ports";
import type { JWK } from "jose";

const CACHE_KEY = "oidc:jwks";
/** How long a cached key set is believed. A key GitHub removes stops verifying within this bound. */
export const JWKS_FRESH_MS = 60_000;
const CACHE_TTL_S = 3_600;

export class JwksUnavailable extends Error {}

export interface JwksDeps {
  kv: KV;
  clock: Clock;
  fetch: typeof fetch;
  url: string;
}

interface Entry {
  url: string;
  fetched_at: number;
  keys: JWK[];
}

function parse(text: string | null): Entry | null {
  if (!text) return null;
  try {
    const entry = JSON.parse(text) as Entry;
    return typeof entry.fetched_at === "number" && Array.isArray(entry.keys) ? entry : null;
  } catch {
    return null;
  }
}

async function fetchKeys(deps: JwksDeps): Promise<JWK[]> {
  let response: Response;
  try {
    response = await deps.fetch(deps.url, { headers: { accept: "application/json" }, redirect: "manual" });
  } catch (error) {
    throw new JwksUnavailable(`the key set could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!response.ok) throw new JwksUnavailable(`the key set answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
  if (!body || !Array.isArray(body.keys)) throw new JwksUnavailable("the key set has no keys");
  return body.keys as JWK[];
}

export interface FoundKey {
  jwk: JWK | null;
  /** Which path answered, so a run that never reached the issuer is told apart from one that did. */
  source: "cache" | "fetch";
}

/**
 * The key for `kid`: from the cached set while it is fresh, else from the issuer. A kid the
 * cache does not hold sends the lookup to the issuer too, which is how a rotation is picked up.
 */
export async function findKey(deps: JwksDeps, kid: string): Promise<FoundKey> {
  const now = deps.clock.now();
  const cached = parse(await deps.kv.get(CACHE_KEY));
  // An entry stamped after `now` came from a clock that has since moved back; it is not fresh.
  if (cached && cached.url === deps.url && now - cached.fetched_at >= 0 && now - cached.fetched_at < JWKS_FRESH_MS) {
    const hit = cached.keys.find((k) => k.kid === kid);
    if (hit) return { jwk: hit, source: "cache" };
  }
  const keys = await fetchKeys(deps);
  await deps.kv.put(CACHE_KEY, JSON.stringify({ url: deps.url, fetched_at: now, keys } satisfies Entry), { ttl_seconds: CACHE_TTL_S });
  return { jwk: keys.find((k) => k.kid === kid) ?? null, source: "fetch" };
}
