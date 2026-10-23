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

interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The wire revision the client speaks; sent on every request after initialize. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** SSE events are blank-line separated and their `data:` lines join with newlines. */
function sseMessages(text: string): RpcMessage[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"))
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as RpcMessage);
}

/** The response to request `id`: a stream may carry notifications and other ids before it. */
function responseTo(res: ApiResponse, id: number): RpcMessage {
  if (res.status < 200 || res.status >= 300) {
    throw new InfrastructureError(`MCP endpoint answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const type = res.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream") ? sseMessages(res.text) : res.text ? [JSON.parse(res.text) as RpcMessage] : [];
  const found = messages.find((m) => m.id === id && ("result" in m || "error" in m));
  if (!found) throw new InfrastructureError(`MCP endpoint answered ${res.status} with no JSON-RPC response to request ${id}`);
  return found;
}

/**
 * A minimal MCP client over the driver's own transport, so the same agent verbs run in-process and
 * against a deployment. Tool names live in the Agent module of the World, not here.
 */
export class McpClient {
  private id = 0;
  private session: string | undefined;
  private initialized = false;

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
        ...(this.initialized ? { "mcp-protocol-version": MCP_PROTOCOL_VERSION } : {}),
        ...(this.credentials.bearer ? { authorization: `Bearer ${this.credentials.bearer}` } : {}),
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: message,
    });
  }

  async request(method: string, params?: object): Promise<unknown> {
    const id = ++this.id;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const session = res.headers.get("mcp-session-id");
    if (session) this.session = session;
    const body = responseTo(res, id);
    if (body.error) throw new McpError(body.error.code, body.error.message);
    return body.result;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "packserver-test-world", version: "0.0.0" },
    });
    this.initialized = true;
    const ack = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (ack.status < 200 || ack.status >= 300) throw new InfrastructureError(`MCP endpoint answered ${ack.status} to initialized`);
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
