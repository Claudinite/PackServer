import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResponse } from "../drivers/driver";
import { McpClient, McpError } from "../drivers/mcp";

const reply = (body: unknown, headers: Record<string, string> = {}, sse = false): ApiResponse => {
  const text = sse ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body);
  return { status: 200, headers: new Headers({ "content-type": sse ? "text/event-stream" : "application/json", ...headers }), text, json: () => body };
};

function server(handler: (message: { method?: string; id?: number; params?: unknown }, req: ApiRequest) => ApiResponse) {
  const seen: ApiRequest[] = [];
  const client = new McpClient(async (req) => {
    seen.push(req);
    return handler(req.body as never, req);
  }, { bearer: "pks_x" });
  return { client, seen };
}

describe("the MCP client", () => {
  it("initializes, carries the session id and the bearer, and lists tools from JSON or SSE", async () => {
    const { client, seen } = server((m) => {
      if (m.method === "initialize") return reply({ jsonrpc: "2.0", id: m.id, result: {} }, { "mcp-session-id": "s1" });
      if (m.method === "tools/list") return reply({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "search_packs" }] } }, {}, true);
      return reply({});
    });
    await client.initialize();
    expect(await client.listTools()).toEqual([{ name: "search_packs" }]);
    const list = seen.at(-1)!;
    expect(list.headers).toMatchObject({ "mcp-session-id": "s1", authorization: "Bearer pks_x" });
    expect(list).toMatchObject({ surface: "mcp", method: "POST", path: "/mcp" });
  });

  it("returns a tool's result and raises a protocol error as McpError", async () => {
    const { client } = server((m) =>
      m.method === "tools/call"
        ? reply({ jsonrpc: "2.0", id: m.id, result: { isError: false, content: [{ type: "text", text: "ok" }] } })
        : reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }),
    );
    expect((await client.callTool("search_packs", { q: "gcp" })).content[0]?.text).toBe("ok");
    await expect(client.request("nope")).rejects.toBeInstanceOf(McpError);
  });

  it("reports an endpoint that answers without a message as infrastructure", async () => {
    const { client } = server(() => ({ ...reply({}), text: "" }));
    await expect(client.listTools()).rejects.toThrow(/no JSON-RPC message/);
  });
});
