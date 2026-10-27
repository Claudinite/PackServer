import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Hono, type Context } from "hono";
import { reportedUnderReview } from "@packserver/core/moderation";
import { BodyTooLarge, readBoundedBody } from "@packserver/http";
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

/** The sources this Worker can read itself; the rest stay unwired and answer unknown. */
export const wiredExtras = (runtime: McpRuntime): PackExtras => ({ ...unwiredExtras, reportedUnderReview: (pack) => reportedUnderReview(runtime.ports.d1, pack.id) });

/** One stateless server per request, so the tools close over this request's runtime and this request's caller. */
export function createServer(runtime: McpRuntime, caller: Caller = { kind: "anonymous" }, extras: PackExtras = wiredExtras(runtime)): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerPublicTools(server, runtime, extras, caller);
  registerPrivilegedTools(server, runtime, caller);
  return server;
}

/** The privileged tools a request body names to call, wherever in a batch they sit. */
function privilegedCalls(body: unknown): PrivilegedTool[] {
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
function refuseUnlistedCalls(c: Context, caller: Caller, body: unknown): Response | null {
  for (const tool of privilegedCalls(body)) {
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
    // The SDK buffers whatever it is given, so nothing larger than the cap reaches it or the check below.
    let bytes: Uint8Array | undefined;
    let parsed: unknown;
    if (c.req.method === "POST") {
      try {
        bytes = await readBoundedBody(c);
      } catch (error) {
        if (error instanceof BodyTooLarge) return c.json({ error: "payload_too_large" }, 413);
        throw error;
      }
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        parsed = undefined;
      }
    }
    const refused = refuseUnlistedCalls(c, caller, parsed);
    if (refused) return refused;
    const handler = createMcpHandler(() => createServer(runtime, caller, options.extras), { route: "/mcp" });
    const request = bytes ? new Request(c.req.raw, { body: bytes }) : c.req.raw;
    return handler(request, {}, c.executionCtx as never);
  });
  return app;
}
