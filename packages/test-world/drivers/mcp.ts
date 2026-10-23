import type { ApiRequest, ApiResponse, McpCredentials } from "./driver";
import { InfrastructureError } from "../world/errors";

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpCallResult {
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
}

type Send = (req: ApiRequest) => Promise<ApiResponse>;

/** Streamable HTTP responses are one JSON body or one SSE event carrying it. */
function rpcResult(res: ApiResponse): { result?: unknown; error?: { code: number; message: string } } {
  const type = res.headers.get("content-type") ?? "";
  const payload = type.includes("text/event-stream")
    ? res.text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : res.text;
  if (!payload) throw new InfrastructureError(`MCP endpoint answered ${res.status} with no JSON-RPC message`);
  return JSON.parse(payload) as { result?: unknown; error?: { code: number; message: string } };
}

/**
 * A minimal MCP client over the driver's own transport, so the same agent verbs run in-process and
 * against a deployment. Tool names live in the Agent module of the World, not here.
 */
export class McpClient {
  private id = 0;
  private session: string | undefined;

  constructor(
    private readonly send: Send,
    private readonly credentials: McpCredentials = {},
    private readonly path = "/mcp",
  ) {}

  private async post(message: object): Promise<ApiResponse> {
    return this.send({
      surface: "mcp",
      method: "POST",
      path: this.path,
      headers: {
        accept: "application/json, text/event-stream",
        ...(this.credentials.bearer ? { authorization: `Bearer ${this.credentials.bearer}` } : {}),
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: message,
    });
  }

  async request(method: string, params?: object): Promise<unknown> {
    const res = await this.post({ jsonrpc: "2.0", id: ++this.id, method, ...(params ? { params } : {}) });
    const session = res.headers.get("mcp-session-id");
    if (session) this.session = session;
    const body = rpcResult(res);
    if (body.error) throw new McpError(body.error.code, body.error.message);
    return body.result;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "packserver-test-world", version: "0.0.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    return ((await this.request("tools/list")) as { tools: McpTool[] }).tools;
  }

  async callTool(name: string, args: object = {}): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args })) as McpCallResult;
  }
}

export class McpError extends Error {
  override readonly name = "McpError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
