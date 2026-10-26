import { SearchConfigError, SearchRequestError, SearchUnavailableError, type PackCard } from "@packserver/core/search";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import { categories, search } from "../search";
import { answer, describe, failure, unavailable } from "./result";

/** The pitch is the publisher's text: it leaves the card for `publisher_text`, the rest is the registry's. */
export const PITCH_LIMIT = 1024;

export function mcpCard(card: PackCard) {
  const { pitch, ...rest } = card;
  return { ...rest, publisher_text: { pitch: pitch.slice(0, PITCH_LIMIT) } };
}

export function registerDiscovery(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "search_packs",
    {
      description: describe(
        "Search public packs by task or keyword (names, pitches, tags, skills and meaning). Returns ranked compact cards; use get_pack for detail. Filters: category (see list_categories), part, has_repository, verified_only, verified_domains.",
      ),
      inputSchema: z.object({
        query: z.string().min(1).describe("What you want to do, or words from the pack, e.g. 'deploy to GCP Cloud Run'"),
        category: z.string().optional().describe("One of the names list_categories returns"),
        part: z.string().optional().describe("Keep packs holding this part: rules, skills, checks, guards or tasks"),
        has_repository: z.boolean().optional().describe("Keep packs that link a public repository"),
        verified_only: z.boolean().optional().describe("Keep packs whose publisher is a Verified Publisher"),
        verified_domains: z.array(z.string()).optional().describe("Keep Verified Publishers whose verified domain is in this list"),
        limit: z.number().int().min(1).max(50).optional().describe("How many cards, 20 by default"),
      }),
    },
    async (args) => {
      try {
        const { cards, degraded } = await search(runtime, args);
        return answer({ cards: cards.map(mcpCard), degraded });
      } catch (error) {
        if (error instanceof SearchRequestError) {
          const field = error.reason === "unknown_category" ? "category" : "part";
          return failure(
            error.reason,
            field === "category" ? "That is not a category. Call list_categories for the valid names." : "That is not a part. Use rules, skills, checks, guards or tasks.",
            { suggestion: field === "category" ? "list_categories" : "rules, skills, checks, guards, tasks", publisher_text: { [field]: args[field] } },
          );
        }
        if (error instanceof SearchConfigError || error instanceof SearchUnavailableError) console.error(`search_packs failed: ${error.message}`);
        else console.error(`search_packs failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );

  server.registerTool(
    "list_categories",
    {
      description: describe("List the fixed pack categories with the number of public packs in each."),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return answer({ categories: await categories(runtime) });
      } catch (error) {
        console.error(`list_categories failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );
}
