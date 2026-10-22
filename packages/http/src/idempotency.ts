import type { Context, MiddlewareHandler } from "hono";
import type { KV } from "@packserver/ports";
import { BodyTooLarge, formFields, isFormRequest, readBoundedBody } from "./body";
import { refusal } from "./refusals";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_FIELD = "idempotency-key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RESULT_TTL_S = 24 * 60 * 60;
const PENDING_TTL_S = 60;
const PENDING = "pending";

interface StoredResponse {
  status: number;
  body_hash: string;
  content_type: string | null;
  location: string | null;
  body: string;
}

export interface IdempotencyOptions {
  kv: KV;
  /** Who owns the key, so two callers never collide: the session id or the token's subject. Undefined means anonymous. */
  caller: (c: Context) => string | undefined | Promise<string | undefined>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalFields(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields)
    .map(([k, v]): [string, unknown] => [k, v instanceof File ? { name: v.name, size: v.size } : v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Applies a POST once per (caller, route, key): a replay of the same request gets the first
 * response back, the same key with a different body is refused. Only 2xx and 3xx outcomes are
 * kept; anything else frees the key so a retry runs fresh. An anonymous caller has no identity to
 * scope a replay to, so it is never stored. KV is eventually consistent, so two simultaneous first
 * requests can both pass: the handler's own unique write is the real guard.
 */
export function idempotency(options: IdempotencyOptions): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    let key: string | undefined;
    let bodyHash: string;
    try {
      const fields = await formFields(c);
      const field = fields[IDEMPOTENCY_FIELD];
      key = c.req.header(IDEMPOTENCY_HEADER) ?? (typeof field === "string" ? field : undefined);
      // A form may already have been consumed by an earlier middleware, so it is hashed by its fields.
      const content = isFormRequest(c) ? new TextEncoder().encode(canonicalFields(fields)) : await readBoundedBody(c);
      bodyHash = await sha256Hex(content);
    } catch (error) {
      if (error instanceof BodyTooLarge) return refusal("quota", { status: 413, message: "request body too large" });
      throw error;
    }
    if (!key || !KEY_PATTERN.test(key)) {
      return refusal("forbidden", { status: 400, message: "a valid Idempotency-Key is required" });
    }
    const caller = await options.caller(c);
    if (!caller) return next();
    const slot = `idem:${caller}:${new URL(c.req.url).pathname}:${key}`;

    const existing = await options.kv.get(slot);
    if (existing === PENDING) return refusal("exists", { message: "a request with this key is in progress" });
    if (existing !== null) {
      const stored = JSON.parse(existing) as StoredResponse;
      if (stored.body_hash !== bodyHash) return refusal("exists", { message: "this key was used for a different request" });
      const headers = new Headers({ "idempotent-replay": "true" });
      if (stored.content_type) headers.set("content-type", stored.content_type);
      if (stored.location) headers.set("location", stored.location);
      return new Response(stored.body, { status: stored.status, headers });
    }

    await options.kv.put(slot, PENDING, { ttl_seconds: PENDING_TTL_S });
    try {
      await next();
    } catch (error) {
      await options.kv.delete(slot);
      throw error;
    }
    if (c.res.status < 200 || c.res.status >= 400) {
      await options.kv.delete(slot);
      return;
    }
    const stored: StoredResponse = {
      status: c.res.status,
      body_hash: bodyHash,
      content_type: c.res.headers.get("content-type"),
      location: c.res.headers.get("location"),
      body: await c.res.clone().text(),
    };
    await options.kv.put(slot, JSON.stringify(stored), { ttl_seconds: RESULT_TTL_S });
  };
}
