import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Hono, type Context } from "hono";
import { syncClock } from "@packserver/ports";
import type { McpRuntime } from "../bindings";
import { admit, insufficientScope, unauthorised, type Caller } from "../limits";
import type { OAuthApi } from "../oauth";
import { PRIVILEGED_TOOLS, isPrivilegedTool, mayCall, registerPrivilegedTools, type PrivilegedTool } from "../privileged";
import { registerPublicTools, unwiredExtras, type PackExtras } from "../tools";

export interface McpOptions {
  extras?: PackExtras;
  oauth?: OAuthApi;
}

export const SERVER_INFO = { name: "packserver", version: "0.0.1" } as const;

/** One stateless server per request, so the tools close over this request's runtime and this request's caller. */
export function createServer(runtime: McpRuntime, caller: Caller = { kind: "anonymous" }, extras: PackExtras = unwiredExtras): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerPublicTools(server, runtime, extras, caller);
  registerPrivilegedTools(server, runtime, caller);
  return server;
}

/** The privileged tools a request names to call, wherever in a batch they sit. */
async function privilegedCalls(request: Request): Promise<PrivilegedTool[]> {
  if (request.method !== "POST") return [];
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return [];
  }
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    const message = m as { method?: unknown; params?: { name?: unknown } } | null;
    const name = message?.params?.name;
    return message?.method === "tools/call" && isPrivilegedTool(name) ? [name] : [];
  });
}

/**
 * A privileged tool called by name by someone it was not listed to is refused before any server exists:
 * no credential gets the sign-in challenge, a credential without the scope gets the scope challenge.
 */
async function refuseUnlistedCalls(c: Context, caller: Caller): Promise<Response | null> {
  for (const tool of await privilegedCalls(c.req.raw)) {
    if (mayCall(caller, tool)) continue;
    return caller.kind === "anonymous" ? unauthorised(c) : insufficientScope(c, PRIVILEGED_TOOLS[tool]);
  }
  return null;
}

export function routes(runtime: McpRuntime, options: McpOptions = {}): Hono {
  const app = new Hono();
  app.all("/mcp", async (c) => {
    await syncClock(runtime.tokenClock);
    const caller = await admit(runtime, c, options.oauth);
    if (caller instanceof Response) return caller;
    const refused = await refuseUnlistedCalls(c, caller);
    if (refused) return refused;
    const handler = createMcpHandler(() => createServer(runtime, caller, options.extras), { route: "/mcp" });
    return handler(c.req.raw, {}, c.executionCtx as never);
  });
  return app;
}
