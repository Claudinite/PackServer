import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    cspNonce: string;
    /** Set by a page that renders the Turnstile widget; only such a page's policy names Cloudflare's challenge host. */
    turnstilePage?: boolean;
    /** Set by a page whose script PUTs an archive straight to the staging bucket (REQ-PUB-016). */
    directUploadPage?: boolean;
  }
}

export function makeNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The one third-party origin any page may name, and only the pages that render the human check. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The staging bucket's S3 endpoint, which a presigned PUT from the publish wizard goes to. */
export const STAGING_UPLOAD_ORIGIN = "https://*.r2.cloudflarestorage.com";

/** No `unsafe-inline` for script or style: an inline block runs only under the per-response nonce. */
export function contentSecurityPolicy(nonce: string, options: { turnstile?: boolean; directUpload?: boolean } = {}): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${options.turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    ...(options.turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${options.directUpload ? ` ${STAGING_UPLOAD_ORIGIN}` : ""}`,
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
    const html = (c.res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
    const apply = (headers: Headers): void => {
      for (const [name, value] of Object.entries(baseSecurityHeaders)) headers.set(name, value);
      headers.set("content-security-policy", html ? contentSecurityPolicy(nonce, { turnstile: c.get("turnstilePage") === true, directUpload: c.get("directUploadPage") === true }) : NON_HTML_CSP);
      headers.delete("access-control-allow-credentials");
      const origin = headers.get("access-control-allow-origin");
      if (origin !== null && origin !== "*") headers.delete("access-control-allow-origin");
    };
    try {
      apply(c.res.headers);
    } catch {
      const headers = new Headers(c.res.headers);
      apply(headers);
      c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    }
  };
}
