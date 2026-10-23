import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    cspNonce: string;
  }
}

export function makeNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** No `unsafe-inline` for script or style: an inline block runs only under the per-response nonce. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Anything that is not a page (JSON, SVG, text) can run nothing and cannot be framed, whatever its content type turns out to be. */
export const NON_HTML_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Two years, as the preload list requires. */
export const HSTS = "max-age=63072000; includeSubDomains; preload";

export const baseSecurityHeaders: Readonly<Record<string, string>> = {
  "strict-transport-security": HSTS,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * Sets the baseline headers and a CSP on every response (the page policy on HTML, a sandboxed deny-all otherwise), and makes sure no
 * response lets a foreign origin read a credentialed answer: `Access-Control-Allow-Credentials`
 * is removed, and an allowed origin other than `*` is removed with it.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    const nonce = makeNonce();
    c.set("cspNonce", nonce);
    await next();
    for (const [name, value] of Object.entries(baseSecurityHeaders)) c.res.headers.set(name, value);
    const html = (c.res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
    c.res.headers.set("content-security-policy", html ? contentSecurityPolicy(nonce) : NON_HTML_CSP);
    c.res.headers.delete("access-control-allow-credentials");
    const origin = c.res.headers.get("access-control-allow-origin");
    if (origin !== null && origin !== "*") c.res.headers.delete("access-control-allow-origin");
  };
}
