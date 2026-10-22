import type { MiddlewareHandler } from "hono";

export const VERSION_HEADER = "X-PackServer-Version";

/** Mount first: the header lands on handler responses, thrown-error responses and the 404 alike. */
export function versionHeader(releaseId: string): MiddlewareHandler {
  return async (c, next) => {
    c.header(VERSION_HEADER, releaseId);
    await next();
    if (c.res.headers.get(VERSION_HEADER) === releaseId) return;
    try {
      c.res.headers.set(VERSION_HEADER, releaseId);
    } catch {
      // A response with immutable headers (a fetched or redirect response) is rebuilt to carry the header.
      const headers = new Headers(c.res.headers);
      headers.set(VERSION_HEADER, releaseId);
      c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    }
  };
}
