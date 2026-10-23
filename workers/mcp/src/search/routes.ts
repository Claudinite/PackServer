import { Hono } from "hono";
import { SearchRequest } from "@packserver/schema";
import { SearchConfigError, SearchRequestError } from "@packserver/core/search";
import type { McpRuntime } from "../bindings";
import { categories, search, trending } from "./run";

const NO_STORE = { "cache-control": "no-store" };

/**
 * The search RPC `web` calls over its service binding. No route of this Worker's public hostnames
 * reaches `/internal`; the answers are the same public data the MCP tools return.
 */
export function routes(runtime: McpRuntime): Hono {
  const app = new Hono();
  const unavailable = (error: unknown) => {
    const configured = error instanceof SearchConfigError;
    console.error(`search failed: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ error: configured ? "misconfigured" : "unavailable" }, { status: 503, headers: NO_STORE });
  };

  app.post("/search", async (c) => {
    const body = SearchRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return Response.json({ error: "invalid_request", issues: body.error.issues.map((i) => i.message) }, { status: 400, headers: NO_STORE });
    try {
      return Response.json(await search(runtime, body.data), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof SearchRequestError) {
        return Response.json({ error: error.reason, message: error.message, suggestion: error.suggestion }, { status: 400, headers: NO_STORE });
      }
      return unavailable(error);
    }
  });

  app.get("/categories", async () => {
    try {
      return Response.json({ categories: await categories(runtime) }, { headers: NO_STORE });
    } catch (error) {
      return unavailable(error);
    }
  });

  app.get("/trending", async () => {
    try {
      return Response.json({ cards: await trending(runtime) }, { headers: NO_STORE });
    } catch (error) {
      return unavailable(error);
    }
  });

  return app;
}
