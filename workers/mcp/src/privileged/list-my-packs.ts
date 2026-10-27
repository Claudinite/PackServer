import { readablePacks, systemName } from "@packserver/core/access";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import type { Caller } from "../limits";
import { buildListing } from "@packserver/core/catalog";
import { versionRows } from "../tools/catalog";
import { answer, describe, unavailable } from "../tools/result";
import { accessCallerOf } from "./access";

export function registerListMyPacks(server: McpServer, runtime: McpRuntime, caller: Caller): void {
  const access = accessCallerOf(caller);
  if (!access) return;
  server.registerTool(
    "list_my_packs",
    {
      description: describe("List the private packs this credential may read: name, newest eligible version and pitch. Public packs are not listed; search finds those."),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const packs = await readablePacks(runtime.ports.d1, access);
        const out = [];
        for (const pack of packs) {
          const rows = await versionRows(runtime, pack.id);
          const listing = buildListing(systemName(pack), rows, new Map());
          const pitch = (await runtime.ports.d1.query("SELECT pitch FROM pack_search WHERE pack_id = ?", [pack.id])).rows[0]?.pitch;
          const newest = rows.find((r) => r.version === listing.latest_eligible);
          out.push({
            id: systemName(pack),
            visibility: "private",
            status: listing.status,
            newest_eligible: newest ? { version: newest.version, published_at: newest.published_at } : null,
            publisher_text: { pitch: typeof pitch === "string" ? pitch : null },
          });
        }
        return answer({ packs: out });
      } catch (error) {
        console.error(`list_my_packs failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );
}
