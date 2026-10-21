import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  PACKS_PUBLIC_BASE_URL: string;
}

interface PackRow {
  id: number;
  name: string;
  version: string;
  category: string;
  summary: string;
  description: string;
  keywords: string;
  features: string;
  repo_url: string | null;
  r2_key: string;
  stars: number;
  visibility: string;
  created_at: string;
}

function toPack(row: PackRow, env: Env) {
  return {
    name: row.name,
    version: row.version,
    category: row.category,
    summary: row.summary,
    description: row.description,
    keywords: row.keywords.split(/\s+/).filter(Boolean),
    features: JSON.parse(row.features) as Record<string, number>,
    repo_url: row.repo_url, // null => "no public repo" badge on the site
    stars: row.stars,
    visibility: row.visibility,
    created_at: row.created_at,
    download_url: `${env.PACKS_PUBLIC_BASE_URL.replace(/\/$/, "")}/${row.r2_key}`,
  };
}

// Turn free text into a safe FTS5 MATCH expression: quote each term and
// add a prefix wildcard so partial words (e.g. "postg") still hit.
function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"*`).join(" ");
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function createServer(env: Env) {
  const server = new McpServer({ name: "packserver", version: "0.0.1" });

  server.registerTool(
    "list_categories",
    {
      description: "List pack categories with the number of public packs in each.",
      inputSchema: z.object({}),
    },
    async () => {
      const { results } = await env.DB.prepare(
        `SELECT category, COUNT(*) AS count FROM packs
         WHERE visibility = 'public' GROUP BY category ORDER BY count DESC, category`,
      ).all<{ category: string; count: number }>();
      return json(results);
    },
  );

  server.registerTool(
    "search_packs",
    {
      description:
        "Full-text search over public packs by name, summary, description and keywords. Optionally filter by category.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Free-text query, e.g. 'gcp iam' or 'postgres'"),
        category: z.string().optional().describe("Restrict to a category, e.g. 'cloud'"),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ query, category, limit }) => {
      const match = ftsQuery(query);
      if (!match) return json([]);
      const sql = `
        SELECT p.*, bm25(packs_fts, 10.0, 5.0, 1.0, 3.0) AS rank
        FROM packs_fts
        JOIN packs p ON p.id = packs_fts.rowid
        WHERE packs_fts MATCH ?1
          AND p.visibility = 'public'
          ${category ? "AND p.category = ?3" : ""}
        ORDER BY rank
        LIMIT ?2`;
      const stmt = env.DB.prepare(sql);
      const bound = category ? stmt.bind(match, limit, category) : stmt.bind(match, limit);
      const { results } = await bound.all<PackRow & { rank: number }>();
      return json(
        results.map((r) => ({
          name: r.name,
          version: r.version,
          category: r.category,
          summary: r.summary,
          stars: r.stars,
          rank: r.rank,
        })),
      );
    },
  );

  server.registerTool(
    "get_pack",
    {
      description: "Get full metadata and the download URL for one pack by exact name.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact pack name, e.g. '@google/gcp-basics'"),
      }),
    },
    async ({ name }) => {
      const row = await env.DB.prepare(`SELECT * FROM packs WHERE name = ?1`)
        .bind(name)
        .first<PackRow>();
      if (!row) {
        return { isError: true, content: [{ type: "text" as const, text: `Pack not found: ${name}` }] };
      }
      return json(toPack(row, env));
    },
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, mcp: "/mcp" });
    }
    // Stateless Streamable HTTP: a fresh McpServer per request, no Durable Objects.
    // Handler is built per request so tools can close over `env` (D1/R2 bindings).
    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
      responseMode: "json",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
