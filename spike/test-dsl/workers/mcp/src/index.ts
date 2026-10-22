// "mcp" Worker: answers searches for agents over the shared D1 (FTS5).
// Plain JSON over HTTP here; the real thing speaks MCP (see spike/mcp-worker).
import { record } from "../../shared-record";

// Baked in at build time with `wrangler deploy --dry-run --define BUILD_ID:'"..."'`; "src" when run from source.
declare const BUILD_ID: string | undefined;
const build = typeof BUILD_ID === "string" ? BUILD_ID : "src";

export interface Env {
  DB: D1Database;
}

function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, worker: "mcp", build });
    if (url.pathname === "/search") {
      const q = ftsQuery(url.searchParams.get("q") ?? "");
      const { results } = q
        ? await env.DB.prepare(
            `SELECT p.name, p.summary FROM packs_fts f JOIN packs p ON p.id = f.rowid
             WHERE packs_fts MATCH ? AND p.visibility = 'public' ORDER BY bm25(packs_fts) LIMIT 20`,
          )
            .bind(q)
            .all<{ name: string; summary: string }>()
        : { results: [] };
      record({ kind: "d1", target: "packs_fts", op: "match", request: { q }, result: { count: results.length }, effect: "read" });
      return Response.json({ results, build });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
