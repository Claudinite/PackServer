import { listCategories, search as coreSearch, trending as coreTrending, type SearchPorts, type SearchRequestBody, type SearchResponseBody } from "@packserver/core/search";
import type { McpRuntime } from "../bindings";


function portsOf(runtime: McpRuntime): SearchPorts {
  const { d1, embedder, vectors, clock, kv } = runtime.ports;
  const cache = kv.OAUTH_KV;
  if (!cache) throw new Error("the OAUTH_KV binding is missing");
  return { d1, embedder, vectors, clock, kv: cache };
}

/** The one search both the site (over its service binding) and the MCP tools answer from. */
export function search(runtime: McpRuntime, request: SearchRequestBody): Promise<SearchResponseBody> {
  return coreSearch(portsOf(runtime), runtime.config.search, request);
}

export const categories = (runtime: McpRuntime) => listCategories(runtime.ports.d1);

export const trending = (runtime: McpRuntime, limit?: number) => coreTrending(runtime.ports.d1, limit);
