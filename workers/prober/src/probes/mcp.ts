import { McpClient, type McpCallResult } from "@packserver/test-world/http-runtime";
import { fetchBytes } from "../transport";
import { fail, pass, type Probe, type ProbeContext } from "./types";

export const PUBLIC_TOOLS = ["get_download", "get_pack", "list_categories", "search_packs"] as const;

async function client(ctx: ProbeContext): Promise<McpClient> {
  const mcp = new McpClient(ctx.registry);
  await mcp.initialize();
  return mcp;
}

/** A tool's answer as the object it carries, or null when it is an error or not an object. */
function answerOf(result: McpCallResult): Record<string, unknown> | null {
  if (result.isError) return null;
  const text = result.content.find((c) => c.type === "text")?.text;
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const cardIds = (answer: Record<string, unknown>): string[] =>
  Array.isArray(answer.cards) ? answer.cards.flatMap((c: unknown) => (c !== null && typeof c === "object" && typeof (c as { id?: unknown }).id === "string" ? [(c as { id: string }).id] : [])) : [];

/** The handshake and the four tools an anonymous agent is offered. */
export const mcpProbe: Probe = async (ctx) => {
  const mcp = await client(ctx);
  const tools = (await mcp.listTools()).map((t) => t.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify([...PUBLIC_TOOLS])) return fail(`an anonymous agent is offered ${tools.length} tools, not the four public ones`);
  const categories = answerOf(await mcp.callTool("list_categories"));
  if (!categories || !Array.isArray(categories.categories)) return fail("list_categories did not answer");
  const search = answerOf(await mcp.callTool("search_packs", { query: "canary", limit: 5 }));
  if (!search || !Array.isArray(search.cards)) return fail("search_packs did not answer");
  return pass("initialized and listed the four public tools");
};

/** Finding the fixture by its words, and the semantic leg answering rather than degrading. */
export const searchProbe: Probe = async (ctx) => {
  const mcp = await client(ctx);
  const lexical = answerOf(await mcp.callTool("search_packs", { query: "canary notes", limit: 50 }));
  if (!lexical) return fail("search_packs did not answer a keyword query");
  if (!cardIds(lexical).includes(ctx.config.canary.pack)) return fail(`a keyword query did not find ${ctx.config.canary.pack}`);
  // A query by meaning; a degraded answer is the lexical leg alone.
  const semantic = answerOf(await mcp.callTool("search_packs", { query: "something that keeps an eye on whether the service is healthy", limit: 5 }));
  if (!semantic) return fail("search_packs did not answer a query by meaning");
  if (semantic.degraded !== false || lexical.degraded !== false) return fail("search answered without its semantic leg");
  return pass("keyword and semantic search both answered");
};

/** An agent's whole adoption path for a public pack: read it, resolve its download, and check the bytes against the pin. */
export const adoptProbe: Probe = async (ctx) => {
  const { canary, packsOrigin } = ctx.config;
  const mcp = await client(ctx);
  const view = answerOf(await mcp.callTool("get_pack", { name: canary.pack }));
  if (!view) return fail(`get_pack did not answer for ${canary.pack}`);
  const download = answerOf(await mcp.callTool("get_download", { name: canary.pack, version: canary.version }));
  if (!download) return fail(`get_download did not answer for ${canary.pack}@${canary.version}`);
  if (download.sha256 !== canary.sha256) return fail("get_download names a hash other than the pinned one");
  if (typeof download.url !== "string" || typeof download.attestation_url !== "string") return fail("get_download names no archive or attestation");
  const cdn = new URL(packsOrigin);
  for (const url of [download.url, download.attestation_url]) {
    if (new URL(url).origin !== cdn.origin) return fail("get_download sends the agent somewhere other than the CDN");
  }
  const archive = await fetchBytes(ctx.fetch, download.url);
  if (archive.status !== 200) return fail(`the archive answered ${archive.status}`);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", archive.bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== canary.sha256) return fail("the archive served does not hash to the pin");
  const attestation = await fetchBytes(ctx.fetch, download.attestation_url);
  if (attestation.status !== 200) return fail(`the attestation answered ${attestation.status}`);
  return pass("the archive hashes to the pin");
};
