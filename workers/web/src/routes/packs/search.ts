import { Hono, type Context } from "hono";
import { SearchRequest, SearchResponse } from "@packserver/schema";
import { CACHE_PRIVATE, CACHE_PUBLIC_VIEW, viewCacheControl } from "@packserver/core/catalog";
import { runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": CACHE_PRIVATE };
const MCP = "http://mcp.internal/internal";

const list = (value: string | undefined): string[] | undefined => {
  const items = value?.split(",").map((v) => v.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
};
const flag = (value: string | undefined): true | undefined => (value === "1" || value === "true" ? true : undefined);
const count = (value: string | undefined): number | undefined => (value === undefined || value === "" ? undefined : Number(value));

/** The query string is the whole state of a search; the filters are those of the MCP tool. */
function requestOf(c: Context<WebEnv>): unknown {
  const q = c.req.query();
  const domains = list(q.verified_domains);
  return {
    ...(q.q ? { query: q.q } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.part ? { part: q.part } : {}),
    ...(flag(q.has_repository) ? { has_repository: true } : {}),
    ...(flag(q.verified) ? { verified_only: true } : {}),
    ...(domains ? { verified_domains: domains } : {}),
    ...(q.engine_version ? { engine_version: q.engine_version } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(count(q.limit) !== undefined ? { limit: count(q.limit) } : {}),
    ...(count(q.offset) !== undefined ? { offset: count(q.offset) } : {}),
  };
}

const cacheFor = (c: Context<WebEnv>): string =>
  viewCacheControl({ cookie: c.req.header("cookie") ?? null, authorization: c.req.header("authorization") ?? null });

/** Asks `mcp`, which owns the one search implementation; a refusal of the request is passed on as it was made. */
async function ask(c: Context<WebEnv>, path: string, init?: RequestInit): Promise<Response | { json: unknown }> {
  let res: Response;
  try {
    res = await runtimeOf(c).services.mcp.fetch(`${MCP}${path}`, init);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (res.status === 400) return Response.json(await res.json().catch(() => ({ error: "invalid_request" })), { status: 400, headers: NO_STORE });
  if (res.status === 503) return Response.json(await res.json().catch(() => ({ error: "unavailable" })), { status: 503, headers: NO_STORE });
  if (!res.ok) return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  return { json: await res.json().catch(() => undefined) };
}

routes.get("/search", async (c) => {
  const parsed = SearchRequest.safeParse(requestOf(c));
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => i.message) }, { status: 400, headers: NO_STORE });
  const answer = await ask(c, "/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) });
  if (answer instanceof Response) return answer;
  const body = SearchResponse.safeParse(answer.json);
  if (!body.success) return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  // A degraded answer is a fallback: it must not outlive the outage in a shared cache.
  return Response.json(body.data, { headers: { "cache-control": body.data.degraded ? CACHE_PRIVATE : cacheFor(c) } });
});

routes.get("/categories", async (c) => {
  const answer = await ask(c, "/categories");
  if (answer instanceof Response) return answer;
  return Response.json(answer.json, { headers: { "cache-control": cacheFor(c) } });
});

routes.get("/trending", async (c) => {
  const answer = await ask(c, "/trending");
  if (answer instanceof Response) return answer;
  return Response.json(answer.json, { headers: { "cache-control": cacheFor(c) === CACHE_PRIVATE ? CACHE_PRIVATE : CACHE_PUBLIC_VIEW } });
});
