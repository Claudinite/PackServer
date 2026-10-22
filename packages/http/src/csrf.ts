import type { Context, MiddlewareHandler } from "hono";
import { BodyTooLarge, formFields } from "./body";
import { refusal } from "./refusals";

export const CSRF_HEADER = "X-CSRF-Token";
export const CSRF_FIELD = "csrf";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The token a page embeds: bound to the session, so one taken from another session fails. */
export async function csrfToken(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`csrf:${sessionId}`)));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CsrfOptions {
  secret: string;
  /** The session's id, or undefined when the caller has none. T-020 supplies the session middleware. */
  sessionId: (c: Context) => string | undefined | Promise<string | undefined>;
  /** Origins a state-changing request may come from. */
  allowedOrigins: readonly string[];
}

async function presentedToken(c: Context): Promise<string | undefined> {
  const header = c.req.header(CSRF_HEADER);
  if (header) return header;
  const field = (await formFields(c))[CSRF_FIELD];
  return typeof field === "string" ? field : undefined;
}

/** Refuses an unsafe-method request from a foreign or missing origin, or without the session's token. */
export function csrf(options: CsrfOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin === undefined || !options.allowedOrigins.includes(origin)) {
      return refusal("forbidden", { message: "cross-site request" });
    }
    const session = await options.sessionId(c);
    if (!session) return refusal("signed-out");
    let presented: string | undefined;
    try {
      presented = await presentedToken(c);
    } catch (error) {
      if (error instanceof BodyTooLarge) return refusal("quota", { status: 413, message: "request body too large" });
      throw error;
    }
    if (!presented || !sameString(presented, await csrfToken(options.secret, session))) {
      return refusal("forbidden", { message: "missing or invalid CSRF token" });
    }
    return next();
  };
}
