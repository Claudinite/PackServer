import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { syncClock } from "@packserver/ports";
import type { McpRuntime } from "../bindings";
import { admit } from "../limits";
import { registerPublicTools, unwiredExtras, type PackExtras } from "../tools";

export interface McpOptions {
  extras?: PackExtras;
}

export const SERVER_INFO = { name: "packserver", version: "0.0.1" } as const;

/** One stateless server per request, so the tools close over this request's runtime. */
export function createServer(runtime: McpRuntime, extras: PackExtras = unwiredExtras): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerPublicTools(server, runtime, extras);
  return server;
}

export function routes(runtime: McpRuntime, options: McpOptions = {}): Hono {
  const app = new Hono();
  app.all("/mcp", async (c) => {
    await syncClock(runtime.tokenClock);
    const caller = await admit(runtime, c);
    if (caller instanceof Response) return caller;
    const handler = createMcpHandler(() => createServer(runtime, options.extras), { route: "/mcp" });
    return handler(c.req.raw, {}, c.executionCtx as never);
  });
  return app;
}
