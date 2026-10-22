import type { Context, MiddlewareHandler } from "hono";
import type { KV } from "@packserver/ports";
import { refusal } from "./refusals";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_TTL_S = 24 * 60 * 60;
const PENDING = "pending";

interface StoredResponse {
  status: number;
  content_type: string | null;
  location: string | null;
  body: string;
}

export interface IdempotencyOptions {
  kv: KV;
  /** Who owns the key, so two callers never collide: the session id or the token's subject. */
  caller: (c: Context) => string | undefined | Promise<string | undefined>;
  ttl_seconds?: number;
}

/**
 * Applies a POST once per (caller, route, key): a replay gets the first response back. KV is not
 * atomic, so two truly simultaneous first requests can both pass; the claim narrows that window
 * and the handler's own write must stay safe against it.
 */
export function idempotency(options: IdempotencyOptions): MiddlewareHandler {
  const ttl = options.ttl_seconds ?? DEFAULT_TTL_S;
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (!key || !KEY_PATTERN.test(key)) {
      return refusal("forbidden", { status: 400, message: "a valid Idempotency-Key header is required" });
    }
    const caller = (await options.caller(c)) ?? "anonymous";
    const slot = `idem:${caller}:${new URL(c.req.url).pathname}:${key}`;

    const existing = await options.kv.get(slot);
    if (existing === PENDING) return refusal("exists", { message: "a request with this key is in progress" });
    if (existing !== null) {
      const stored = JSON.parse(existing) as StoredResponse;
      const headers = new Headers({ "idempotent-replay": "true" });
      if (stored.content_type) headers.set("content-type", stored.content_type);
      if (stored.location) headers.set("location", stored.location);
      return new Response(stored.body, { status: stored.status, headers });
    }

    await options.kv.put(slot, PENDING, { ttl_seconds: ttl });
    try {
      await next();
    } catch (error) {
      await options.kv.delete(slot);
      throw error;
    }
    if (c.res.status >= 500) {
      await options.kv.delete(slot);
      return;
    }
    const stored: StoredResponse = {
      status: c.res.status,
      content_type: c.res.headers.get("content-type"),
      location: c.res.headers.get("location"),
      body: await c.res.clone().text(),
    };
    await options.kv.put(slot, JSON.stringify(stored), { ttl_seconds: ttl });
  };
}
