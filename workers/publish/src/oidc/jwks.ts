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
 * The issuer is asked at most once per this long, whatever kids callers present: a token's header
 * is unsigned, so an anonymous caller picks the kid. GitHub publishes a key before it signs with it.
 */
export const JWKS_REFETCH_COOLDOWN_MS = 10_000;

/** What this isolate last learned from the issuer, so the cooldown holds when the KV write is lost. */
interface Seen {
  at: number;
  failed: boolean;
  keys: JWK[];
}
const memory = new Map<string, Seen>();
const inflight = new Map<string, Promise<JWK[]>>();

export function resetJwksMemory(): void {
  memory.clear();
  inflight.clear();
}

async function readCache(deps: JwksDeps): Promise<Entry | null> {
  try {
    const entry = parse(await deps.kv.get(CACHE_KEY));
    return entry && entry.url === deps.url ? entry : null;
  } catch (error) {
    console.log(JSON.stringify({ event: "oidc.jwks_cache_read_failed", detail: error instanceof Error ? error.message : "unknown error" }));
    return null;
  }
}

async function refresh(deps: JwksDeps, now: number): Promise<JWK[]> {
  const running = inflight.get(deps.url);
  if (running) return running;
  const run = (async () => {
    try {
      const keys = await fetchKeys(deps);
      memory.set(deps.url, { at: now, failed: false, keys });
      try {
        await deps.kv.put(CACHE_KEY, JSON.stringify({ url: deps.url, fetched_at: now, keys } satisfies Entry), { ttl_seconds: CACHE_TTL_S });
      } catch (error) {
        console.log(JSON.stringify({ event: "oidc.jwks_cache_write_failed", detail: error instanceof Error ? error.message : "unknown error" }));
      }
      return keys;
    } catch (error) {
      memory.set(deps.url, { at: now, failed: true, keys: [] });
      throw error;
    } finally {
      inflight.delete(deps.url);
    }
  })();
  inflight.set(deps.url, run);
  return run;
}

/**
 * The key for `kid`: from the cached set while it is fresh, else from the issuer. A kid the
 * cache does not hold sends the lookup to the issuer too, which is how a rotation is picked up,
 * but only once the cooldown since the last fetch has passed; inside it the kid is simply unknown.
 */
export async function findKey(deps: JwksDeps, kid: string): Promise<FoundKey> {
  const now = deps.clock.now();
  const cached = await readCache(deps);
  // An entry stamped after `now` came from a clock that has since moved back; it is not fresh.
  const age = cached ? now - cached.fetched_at : -1;
  if (cached && age >= 0 && age < JWKS_FRESH_MS) {
    const hit = cached.keys.find((k) => k.kid === kid);
    if (hit) return { jwk: hit, source: "cache" };
  }
  const recent = [memory.get(deps.url), cached ? { at: cached.fetched_at, failed: false, keys: cached.keys } : undefined]
    .filter((m): m is Seen => m !== undefined && now - m.at >= 0 && now - m.at < JWKS_REFETCH_COOLDOWN_MS)
    .sort((x, y) => y.at - x.at)[0];
  if (recent) {
    if (recent.failed) throw new JwksUnavailable("the key set could not be fetched a moment ago");
    return { jwk: recent.keys.find((k) => k.kid === kid) ?? null, source: "cache" };
  }
  const keys = await refresh(deps, now);
  return { jwk: keys.find((k) => k.kid === kid) ?? null, source: "fetch" };
}
